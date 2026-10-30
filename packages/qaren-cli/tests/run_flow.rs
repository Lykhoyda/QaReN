mod common;
use common::IosBuildRunner as MockRunner;

use qaren::core::Budgets;
use qaren::exec::{CmdOutput, CmdSpec, HoldStdout, PipedChild, Runner, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::run::{run, RunRequest};
use qaren::runrecord::{Phase, RunRecord};
use qaren::scenario::Platform;
use std::path::{Path, PathBuf};

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const LSTART: &str = "Wed Aug 12 16:01:00 2026";
const TEST_KEY: &str = "hermetic-typesafe-key";

fn probe_json() -> serde_json::Value {
    serde_json::json!({"calls":1,"medianMs":12,"inputTokens":10,"callDetails":[{
        "scope":"preflight","questionIds":["preflight"],"inputTokens":10,"ms":12,"outcome":"ok","status":200
    }]})
}

fn script_plan(mock: &mut MockRunner, repo: &Path) {
    script_plan_requiring(mock, repo, &[], &[]);
}

fn script_plan_requiring(
    mock: &mut MockRunner,
    repo: &Path,
    required: &[&str],
    non_secret: &[&str],
) {
    mock.environment
        .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
    let plan = std::fs::read(repo.join("test-app/plan.md")).unwrap();
    let output = serde_json::json!({"ok":true,"prepared":{
        "hash":qaren::candidate::sha256_hex(&plan),"blocks":[]
    },"jev":probe_json()});
    let config = std::fs::read_to_string(repo.join("test-app/.qaren/config.yaml")).unwrap();
    let login = config
        .lines()
        .find_map(|line| line.strip_prefix("loginBlock: "))
        .map(|slug| serde_json::json!({"slug": slug, "content": null}));
    let mut inventory = serde_json::json!({"ok":true,"inputProtocol":1,"requiredInputs":required});
    if let Some(login) = &login {
        inventory["loginSnapshot"] = login.clone();
    }
    if !non_secret.is_empty() {
        inventory["nonSecretInputs"] = serde_json::json!(non_secret);
    }
    let inventory = inventory.to_string();
    mock.expect_run("walk.js --preflight-stdin", CmdOutput::success(&inventory));
    let mut output = private_preflight(output);
    output["requiredInputs"] = serde_json::json!(required);
    if !non_secret.is_empty() {
        output["nonSecretInputs"] = serde_json::json!(non_secret);
    }
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput::success(&output.to_string()),
    );
    // A configured login block is re-read before the device is resolved.
    if login.is_some() {
        mock.expect_run("walk.js --preflight-stdin", CmdOutput::success(&inventory));
    }
}

fn script_inventory(mock: &mut MockRunner) {
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput::success(r#"{"ok":true,"inputProtocol":1,"requiredInputs":[]}"#),
    );
}

fn private_preflight(mut output: serde_json::Value) -> serde_json::Value {
    output["inputProtocol"] = 1.into();
    output["requiredInputs"] = serde_json::json!([]);
    output
}
// MockRunner's clock is frozen until the first sleep, so the run id is deterministic.
fn run_id() -> String {
    format!("check-{}", qaren::timefmt::compact_utc(1_770_000_000_000))
}

// What `main` does around a check: the stream starts before the run and ends with its receipt.
fn run_with_events(
    mock: &mut dyn Runner,
    req: &RunRequest,
) -> (qaren::receipt::Receipt, Vec<serde_json::Value>) {
    qaren::events::init();
    let receipt = run(mock, req);
    qaren::events::end(&receipt, 0);
    qaren::events::finish();
    let path = req
        .runs_root
        .join(&receipt.run_id)
        .join("logs/events.jsonl");
    let events = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (receipt, events)
}

fn stage_trail(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["event"] == "stage")
        .map(|e| {
            let p = &e["payload"];
            match p["code"].as_str() {
                Some(code) => format!(
                    "{} {} {code}",
                    p["name"].as_str().unwrap(),
                    p["state"].as_str().unwrap()
                ),
                None => format!(
                    "{} {}",
                    p["name"].as_str().unwrap(),
                    p["state"].as_str().unwrap()
                ),
            }
        })
        .collect()
}

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

// A temp app repo: <repo>/test-app is the project root with .qaren/config.yaml and a plan.
fn app_repo() -> (PathBuf, PathBuf) {
    let repo = common::temp_repo();
    let app = repo.join("test-app");
    std::fs::create_dir_all(app.join(".qaren")).unwrap();
    std::fs::write(
        app.join(".qaren").join("config.yaml"),
        "appId: com.rndevagent.testapp\nmetroPort: 8791\ndevClientScheme: rndatest\n",
    )
    .unwrap();
    std::fs::write(app.join("plan.md"), "1. Tap \"Tasks\"\n✓ \"Tasks\"\n").unwrap();
    (repo, app)
}

fn request(repo: &Path, app: &Path, step_seconds: u64) -> RunRequest {
    RunRequest {
        project_root: app.to_path_buf(),
        config_path: app.join(".qaren").join("config.yaml"),
        plan_file: app.join("plan.md"),
        platform: Platform::Ios,
        device: None,
        boot_device: false,
        restart_device: false,
        shutdown_device_on_exit: false,
        fresh_install: false,
        runtime_dir: PathBuf::from("/runtime"),
        node: Some(PathBuf::from("/usr/local/bin/node")),
        lock_root: repo.join(".locks"),
        native_cache_root: repo.join(".native-store"),
        runs_root: repo.join("runs"),
        android_home: None,
        budgets: Budgets {
            walk_seconds: 600,
            step_seconds,
        },
        pr: None,
    }
}

fn configure_workspace(app: &Path, workspace: &str, scheme: &str) {
    std::fs::write(
        app.join(".qaren/config.yaml"),
        format!(
            "appId: com.rndevagent.testapp\nmetroPort: 8791\ndevClientScheme: rndatest\nios:\n  build:\n    workspace: {workspace}\n    scheme: {scheme}\n"
        ),
    )
    .unwrap();
}

fn assert_xcode_products_retained(run_dir: &Path) {
    assert_eq!(
        std::fs::read_to_string(run_dir.join("ios-build/libNative.a")).unwrap(),
        "library"
    );
    assert_eq!(
        std::fs::read_to_string(
            run_dir.join("ios-derived-data/Build/Intermediates.noindex/compile.o")
        )
        .unwrap(),
        "intermediate"
    );
}

#[test]
fn workspace_check_uses_a_gated_finite_build_and_persists_the_verified_artifact() {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/Native App.xcworkspace");
    configure_workspace(&app, "ios/Native App.xcworkspace", "Native Debug");
    let canaries = [
        repo.join("runs/other-run/ios-build/canary"),
        repo.join("runs/other-run/ios-derived-data/canary"),
        app.join("ios/DerivedData/canary"),
    ];
    for path in &canaries {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "keep").unwrap();
    }
    let mut mock = MockRunner::new();
    mock.build_log = Some("finite Xcode build log\n".into());
    script_preflight(&mut mock, &repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    assert_direct_ios_launch(&mock);
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "xcodebuild-ios")
        .unwrap();
    assert_eq!(build.program, "/bin/bash");
    assert!(build.args[3].ends_with("exec \"$@\" >&2"));
    assert_eq!(mock.piped_stdin_text(0), "start\n");
    assert!(build.args.iter().any(|a| a == "Native Debug"));
    assert!(!labels(&mock)
        .iter()
        .any(|l| matches!(l.as_str(), "expo-run-ios" | "expo-ios-build-help")));
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(
        record.scenario.build.ios_workspace.unwrap().workspace,
        "ios/Native App.xcworkspace"
    );
    let artifact = record.build.unwrap().artifact.unwrap();
    assert_eq!(
        qaren::buildplan::hash_artifact(&artifact.path).unwrap(),
        artifact.sha256
    );
    let run_dir = repo.join("runs").join(run_id());
    assert!(!run_dir.join("ios-build").exists());
    assert!(!run_dir.join("ios-derived-data").exists());
    assert_eq!(
        std::fs::read_to_string(run_dir.join("logs/xcodebuild-ios.log")).unwrap(),
        "finite Xcode build log\n"
    );
    for path in canaries {
        assert_eq!(std::fs::read_to_string(path).unwrap(), "keep");
    }
    assert_eq!(receipt.cleanup["device_lease"], "removed");
}

#[test]
fn workspace_products_are_retained_when_cache_publication_fails() {
    for failure in ["copy", "state"] {
        let (repo, app) = app_repo();
        common::write_ios_workspace(&app, "ios/Native.xcworkspace");
        configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        let cache = qaren::buildplan::cache_dir(&repo);
        std::fs::create_dir_all(&cache).unwrap();
        if failure == "copy" {
            // Injected after the plan so admission still sees a safe absent root.
        } else {
            std::fs::create_dir(qaren::buildplan::state_path(
                &repo,
                "ios",
                "com.rndevagent.testapp",
            ))
            .unwrap();
        }
        let mut mock = MockRunner::new();
        if failure == "copy" {
            mock.cache_publication_fault = Some(repo.join(".native-store"));
        }
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let receipt = run(&mut mock, &request(&repo, &app, 30));

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        let note = if failure == "copy" {
            "artifact_cache"
        } else {
            "native_cache_state"
        };
        assert!(receipt.outcomes[note].starts_with(if failure == "copy" {
            "skipped:"
        } else {
            "could not persist"
        }));
        let run_dir = repo.join("runs").join(run_id());
        assert!(run_dir.join("ios-build/testapp.app").is_dir());
        assert_xcode_products_retained(&run_dir);
    }
}

#[test]
fn workspace_retirement_refuses_symlinked_roots_before_deleting_any_products() {
    for root in ["ios-build", "ios-derived-data"] {
        let (repo, app) = app_repo();
        common::write_ios_workspace(&app, "ios/Native.xcworkspace");
        configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        let outside = repo.join("runs/outside-build");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("canary"), "keep").unwrap();
        let mut mock = MockRunner::new();
        mock.symlink_build_root = Some(root);
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let receipt = run(&mut mock, &request(&repo, &app, 30));

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        assert!(receipt.outcomes["ios_build_output"].starts_with("retained:"));
        let run_dir = repo.join("runs").join(run_id());
        assert!(run_dir.join(root).is_symlink());
        assert_eq!(
            std::fs::read_to_string(outside.join("canary")).unwrap(),
            "keep"
        );
        assert!(run_dir.join("ios-build/testapp.app").is_dir());
        assert_xcode_products_retained(&run_dir);
        let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
        let artifact = record.build.unwrap().artifact.unwrap();
        assert_eq!(
            qaren::buildplan::hash_artifact(&artifact.path).unwrap(),
            artifact.sha256
        );
    }
}

#[test]
fn workspace_cache_persistence_reuses_only_the_same_workspace_and_scheme() {
    use qaren::buildplan::{self, BuildDecision, StateStatus};
    let (repo, app) = app_repo();
    for workspace in ["ios/First.xcworkspace", "ios/Second.xcworkspace"] {
        common::write_ios_workspace(&app, workspace);
    }
    let mut fingerprints = Vec::new();
    let mut artifacts = Vec::new();
    for (index, (workspace, scheme, reuse)) in [
        ("ios/First.xcworkspace", "Debug", false),
        ("ios/First.xcworkspace", "Debug", true),
        ("ios/First.xcworkspace", "Other Debug", false),
        ("ios/Second.xcworkspace", "Other Debug", false),
    ]
    .into_iter()
    .enumerate()
    {
        configure_workspace(&app, workspace, scheme);
        let mut req = request(&repo, &app, 30);
        req.runs_root = repo.join(format!("runs-{index}"));
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        if reuse {
            mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
            common::script_xcode(&mut mock);
            common::script_ios_install_and_launch(&mut mock);
            script_ready_recheck(&mut mock, common::IOS_NATIVE_FILES);
        } else if index == 0 {
            script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
        } else {
            mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
            common::script_xcode(&mut mock);
            common::script_finite_ios_build_with(&mut mock, "xcodebuild", |m| {
                script_candidate_recheck(m);
                script_fingerprint_recheck(m, common::IOS_NATIVE_FILES)
            });
            script_ready_recheck(&mut mock, common::IOS_NATIVE_FILES);
        }
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        let position = |label: &str| mock.calls.iter().position(|c| c.label == label).unwrap();
        assert!(position("expo-start") < position("simctl-install"));
        assert!(position("simctl-install") < position("metro-status"));
        assert_eq!(
            mock.calls
                .iter()
                .filter(|c| c.label == "expo-start")
                .count(),
            1
        );
        let plan = receipt.build.unwrap();
        assert_eq!(plan.decision == BuildDecision::Reuse, reuse);
        let StateStatus::Loaded(state) =
            buildplan::load_state(&repo, "ios", "com.rndevagent.testapp")
        else {
            panic!("successful build must persist reusable native state");
        };
        assert_eq!(state.fingerprint, plan.fingerprint);
        let artifact = common::stored_record(&req.native_cache_root, "ios", &state.fingerprint)
            .unwrap()
            .artifact;
        assert_eq!(
            artifact.sha256,
            buildplan::hash_artifact(&artifact.path).unwrap()
        );
        if reuse {
            assert!(!mock.calls.iter().any(|c| matches!(
                c.label.as_str(),
                "xcodebuild-ios" | "expo-run-ios" | "expo-prebuild"
            )));
            let install = mock
                .calls
                .iter()
                .find(|c| c.label == "simctl-install")
                .unwrap();
            assert_eq!(install.args[3], artifact.path.to_string_lossy());
        }
        fingerprints.push(state.fingerprint);
        artifacts.push(artifact.path);
    }
    assert_eq!(fingerprints[0], fingerprints[1]);
    assert_eq!(artifacts[0], artifacts[1]);
    assert_ne!(fingerprints[1], fingerprints[2]);
    assert_ne!(artifacts[1], artifacts[2]);
    assert_ne!(fingerprints[2], fingerprints[3]);
    assert_ne!(artifacts[2], artifacts[3]);
}

#[test]
fn a_fresh_clone_reuses_another_clones_build_and_never_overwrites_the_store() {
    use qaren::buildplan::{self, BuildDecision, STORE_RECORD};
    use qaren::exec::Runner;
    let store = common::temp_repo().join("machine-store");
    let mut record_bytes = Vec::new();
    for (index, case) in ["first", "second", "corrupted"].into_iter().enumerate() {
        let (repo, app) = app_repo();
        common::write_ios_workspace(&app, "ios/Native.xcworkspace");
        configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        let mut req = request(&repo, &app, 30);
        req.native_cache_root = store.clone();
        let mut mock = MockRunner::new();
        mock.sleep(std::time::Duration::from_secs(60 * index as u64));
        let reuse = case == "second";
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        if reuse {
            mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
            common::script_xcode(&mut mock);
            common::script_ios_install_and_launch(&mut mock);
            script_ready_recheck(&mut mock, common::IOS_NATIVE_FILES);
        } else {
            script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
        }
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        let shifted = format!(
            "check-{}",
            qaren::timefmt::compact_utc(1_770_000_000_000 + 60_000 * index as u64)
        );
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &pass_stdout().replace(&run_id(), &shifted),
            Some(0),
        );
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let receipt = run(&mut mock, &req);

        assert_eq!(
            receipt.result,
            ReceiptResult::Pass,
            "{case}: {:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0, "{case}");
        let plan = receipt.build.unwrap();
        assert_eq!(
            plan.decision == BuildDecision::Reuse,
            reuse,
            "{case}: {}",
            plan.reason
        );
        let entry =
            buildplan::store_dir(&store, "ios", "com.rndevagent.testapp", &plan.fingerprint);
        let stored = common::stored_record(&store, "ios", &plan.fingerprint).unwrap();
        match case {
            "first" => record_bytes = std::fs::read(entry.join(STORE_RECORD)).unwrap(),
            "second" => {
                assert!(
                    plan.evidence
                        .iter()
                        .any(|e| e.contains("no native cache state recorded")),
                    "{:?}",
                    plan.evidence
                );
                assert!(
                    plan.evidence.iter().any(|e| e.contains(&format!(
                        "artifact from machine store {}",
                        stored.artifact.path.display()
                    ))),
                    "{:?}",
                    plan.evidence
                );
                let install = mock
                    .calls
                    .iter()
                    .find(|c| c.label == "simctl-install")
                    .unwrap();
                assert_eq!(install.args[3], stored.artifact.path.to_string_lossy());
                std::fs::write(stored.artifact.path.join("binary"), b"corrupted").unwrap();
            }
            _ => {
                assert!(
                    receipt.outcomes["artifact_cache"].contains("already holds a build"),
                    "{:?}",
                    receipt.outcomes
                );
                assert_eq!(
                    std::fs::read(&stored.artifact.path.join("binary")).unwrap(),
                    b"corrupted"
                );
            }
        }
        assert_eq!(
            std::fs::read(entry.join(STORE_RECORD)).unwrap(),
            record_bytes,
            "{case}"
        );
    }
}

#[test]
fn invalid_or_missing_workspace_refuses_before_boot_reset_or_any_command() {
    for workspace in ["ios/Missing.xcworkspace", "../Escape.xcworkspace"] {
        let (repo, app) = app_repo();
        configure_workspace(&app, workspace, "Native Debug");
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.boot_device = true;
        req.fresh_install = true;
        let mut mock = MockRunner::new();
        let receipt = run(&mut mock, &req);
        assert_eq!(
            receipt.result,
            if workspace.starts_with("ios/") {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Failed
            }
        );
        assert_eq!(
            receipt.failure.unwrap().code,
            if workspace.starts_with("ios/") {
                FailureCode::IosBuildCapabilityUnavailable
            } else {
                FailureCode::ScenarioInvalid
            }
        );
        assert!(mock.calls.is_empty());
        assert!(!req.runs_root.exists());
        assert!(!req.lock_root.exists());
    }
}

#[test]
fn missing_ios_launch_scheme_refuses_before_boot_reset_or_any_command() {
    let (repo, app) = app_repo();
    std::fs::write(
        app.join(".qaren/config.yaml"),
        "appId: com.rndevagent.testapp\n",
    )
    .unwrap();
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    req.boot_device = true;
    req.fresh_install = true;
    let mut mock = MockRunner::new();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        serde_json::to_value(receipt.failure.unwrap().code).unwrap(),
        "DEV_CLIENT_SCHEME_REQUIRED"
    );
    assert!(mock.calls.is_empty());
    assert!(!req.runs_root.exists());
    assert!(!req.lock_root.exists());
}

#[test]
fn invalid_ios_launch_scheme_refuses_before_any_command_without_echoing_input() {
    for scheme in [
        "private://log-payload",
        "private invalid",
        "private\npayload",
        &"a".repeat(129),
    ] {
        let (repo, app) = app_repo();
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.boot_device = true;
        req.fresh_install = true;
        std::fs::write(
            &req.config_path,
            format!(
                "appId: com.rndevagent.testapp\ndevClientScheme: {}\n",
                serde_json::to_string(scheme).unwrap()
            ),
        )
        .unwrap();
        let mut mock = MockRunner::new();
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::DevClientSchemeRequired
        );
        assert!(!receipt.to_json().contains("private"));
        assert!(!receipt.to_json().contains(&"a".repeat(129)));
        assert!(mock.calls.is_empty());
        assert!(!req.runs_root.exists());
        assert!(!req.lock_root.exists());
    }
}

#[test]
fn a_clean_ios_build_refuses_before_building_when_its_volume_is_short_of_space() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run(
        "df",
        CmdOutput::success(
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 976490576 1 500000000 1% /\n/dev/disk4 976490576 1 4194304 99% /Volumes/apps\n",
        ),
    );

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DiskBudgetExceeded);
    assert!(
        failure
            .detail
            .starts_with("4.0 GiB free on the volume holding")
            && failure
                .detail
                .contains("a clean iOS build needs about 10 GiB"),
        "{}",
        failure.detail
    );
    assert!(
        failure.detail.ends_with("then re-run"),
        "{}",
        failure.detail
    );
    assert!(failure.detail.contains("DerivedData"), "{}", failure.detail);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.rendered().contains("expo prebuild") || c.rendered().contains("expo start")));
    assert!(!req.lock_root.join("native-build-ios").exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn a_check_whose_candidate_moves_during_the_build_never_publishes_and_releases_the_lock() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    // HEAD moved during the build: the recheck under the lock refuses publication.
    mock.expect_run("rev-parse HEAD", CmdOutput::success(&"d".repeat(40)));

    let receipt = run(&mut mock, &req);

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted,
        "{:?}",
        receipt.failure
    );
    assert!(!mock.calls.iter().any(|c| matches!(
        c.label.as_str(),
        "simctl-install" | "expo-start" | "core-walk"
    )));
    assert!(matches!(
        qaren::buildplan::load_state(&repo, "ios", "com.rndevagent.testapp"),
        qaren::buildplan::StateStatus::Missing
    ));
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    let fingerprint = record.build.as_ref().unwrap().fingerprint.clone();
    assert!(
        common::stored_record(&req.native_cache_root, "ios", &fingerprint).is_none(),
        "no machine-store record was published"
    );
    assert!(record.resources.build_lock.is_none());
    assert!(!req.lock_root.join("native-build-ios").exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn pre_spawn_build_error_retires_pending_before_releasing_ownership() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    mock.build_spawn_fault = Some(common::BuildSpawnFault::Error);
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);

    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::BuildFailed);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(record.resources.build_process().is_none());
    assert!(record.resources.build_lock.is_none());
    assert!(record.resources.lease.is_none());
    assert!(!req.lock_root.join("native-build-ios").exists());
    assert!(!req
        .lock_root
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(mock.piped_stdin.is_empty());
    assert_eq!(mock.remaining(), 0);
    assert!(!receipt.cleanup.contains_key("metro"));
}

#[test]
fn unproven_metro_after_the_build_refuses_install_and_retains_its_lease() {
    for workspace in [false, true] {
        let (repo, app) = app_repo();
        if workspace {
            common::write_ios_workspace(&app, "ios/Native.xcworkspace");
            configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        }
        let req = request(&repo, &app, 30);
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        if workspace {
            mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        } else {
            common::script_ios_deps(&mut mock);
        }
        mock.expect_run(
            "ls-files",
            CmdOutput::success(if workspace {
                common::IOS_NATIVE_FILES
            } else {
                ""
            }),
        );
        script_clean_build_plan(&mut mock);
        let native_files = if workspace {
            common::IOS_NATIVE_FILES
        } else {
            ""
        };
        common::script_finite_ios_build_only(
            &mut mock,
            if workspace {
                "xcodebuild"
            } else {
                "expo run:ios"
            },
        );
        script_candidate_recheck(&mut mock);
        script_fingerprint_recheck(&mut mock, native_files);
        common::script_ios_app_verification(&mut mock);
        mock.expect_spawn(
            "expo start",
            Spawned {
                pid: 6000,
                pgid: 6000,
            },
        );
        mock.expect_run("ps", CmdOutput::failed(1, ""));
        mock.expect_run("ps", CmdOutput::failed(1, ""));
        mock.expect_run("lsof", free_port());

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::BuildFailed);
        assert!(receipt.cleanup["metro"].starts_with("unresolved:"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved:"));
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "simctl-install" | "simctl-launch" | "core-walk" | "kill-group"
        )));
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.metro.unwrap().identity.is_none());
        assert!(record.resources.lease.unwrap().lock_dir.exists());
        // The build lock was released before Metro started.
        assert!(record.resources.build_lock.is_none());
        assert!(!req.lock_root.join("native-build-ios").exists());
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn metro_exit_after_install_prevents_launch_and_cleans_up_both_stages() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    script_candidate_recheck(&mut mock);
    script_fingerprint_recheck(&mut mock, "");
    common::script_ios_app_verification(&mut mock);
    common::script_ios_metro_spawn(&mut mock);
    mock.expect_run("simctl install", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::BuildFailed);
    assert_eq!(receipt.cleanup["metro"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!mock
        .calls
        .iter()
        .any(|c| matches!(c.label.as_str(), "simctl-launch" | "core-walk")));
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(record.resources.metro.is_none());
    assert!(record.resources.build_process().is_none());
    assert!(record.resources.build_lock.is_none());
    assert!(record.resources.lease.is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn invalid_spawned_build_group_retains_pending_and_both_locks_without_starting() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    mock.expect_spawn_piped("expo run:ios", 1, "", Some(0));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Failed);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(matches!(
        record.resources.build_process(),
        Some(qaren::runrecord::BuildProcess::SpawnPending)
    ));
    assert!(record.resources.build_lock.unwrap().lock_dir.exists());
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    assert!(receipt.cleanup["build_process"].starts_with("unresolved"));
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
    assert_eq!(mock.piped_stdin_text(0), "");
    assert!(!mock.calls.iter().any(|c| matches!(
        c.label.as_str(),
        "simctl-install" | "simctl-launch" | "core-walk"
    )));
    assert!(!mock.calls.iter().any(|c| c.label == "kill-group"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn failed_spawn_retirement_save_or_interruption_retains_pending_and_both_locks() {
    use common::BuildSpawnFault;
    for fault in [
        BuildSpawnFault::ErrorWithSaveFailure,
        BuildSpawnFault::Interrupted,
    ] {
        let (repo, app) = app_repo();
        let req = request(&repo, &app, 30);
        let mut mock = MockRunner::new();
        mock.build_spawn_fault = Some(fault);
        script_preflight(&mut mock, &repo);
        common::script_ios_deps(&mut mock);
        mock.expect_run("ls-files", CmdOutput::success(""));
        script_clean_build_plan(&mut mock);
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut mock, &req)));
        match fault {
            BuildSpawnFault::Interrupted => assert!(outcome.is_err()),
            _ => {
                let receipt = outcome.unwrap();
                assert_eq!(receipt.result, ReceiptResult::Failed);
                assert!(receipt.cleanup["build_process"].starts_with("unresolved"));
                assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
            }
        }
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(matches!(
            record.resources.build_process(),
            Some(qaren::runrecord::BuildProcess::SpawnPending)
        ));
        assert!(record.resources.build_lock.unwrap().lock_dir.exists());
        assert!(record.resources.lease.unwrap().lock_dir.exists());
        assert!(mock.piped_stdin.is_empty());
        assert_eq!(mock.remaining(), 0);
        assert!(mock.calls.iter().any(|c| c.label == "expo-run-ios"));
    }
}

#[test]
fn finite_build_failures_never_install_or_walk_and_unproven_groups_retain_both_locks() {
    let modes = [
        "missing",
        "ambiguous",
        "wrong_bundle",
        "unsupported_launcher",
        "nonzero",
        "timeout",
        "unknown_group",
        "dead_leader",
        "unknown_identity",
    ];
    for (workspace, mode) in [false, true]
        .into_iter()
        .flat_map(|workspace| modes.map(|mode| (workspace, mode)))
    {
        let (repo, app) = app_repo();
        if workspace {
            common::write_ios_workspace(&app, "ios/Native.xcworkspace");
            configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        }
        let req = request(&repo, &app, 30);
        let mut mock = MockRunner::new();
        mock.omit_app = mode == "missing";
        mock.ambiguous_app = mode == "ambiguous";
        script_preflight(&mut mock, &repo);
        if workspace {
            mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        } else {
            common::script_ios_deps(&mut mock);
        }
        mock.expect_run(
            "ls-files",
            CmdOutput::success(if workspace {
                common::IOS_NATIVE_FILES
            } else {
                ""
            }),
        );
        script_clean_build_plan(&mut mock);
        mock.expect_spawn_piped(
            if workspace {
                "xcodebuild"
            } else {
                "expo run:ios"
            },
            5000,
            "",
            match mode {
                "timeout" => None,
                "nonzero" => Some(65),
                _ => Some(0),
            },
        );
        mock.expect_run(
            "ps",
            if mode == "unknown_identity" {
                CmdOutput::failed(1, "")
            } else {
                CmdOutput::success(LSTART)
            },
        );
        mock.expect_run("ps", CmdOutput::success("qaren-build"));
        let retained = matches!(mode, "unknown_group" | "dead_leader");
        if mode == "timeout" {
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
        } else if mode == "dead_leader" {
            for _ in 0..2 {
                mock.expect_run("ps -A", CmdOutput::success("1 1 S\n5001 5000 S\n"));
                mock.expect_run("ps -p 5000", CmdOutput::failed(1, ""));
                mock.expect_run("ps -A", CmdOutput::success("1 1 S\n5001 5000 S\n"));
            }
        } else {
            for _ in 0..if retained { 2 } else { 1 } {
                mock.expect_run(
                    "ps -A",
                    if retained {
                        CmdOutput::failed(1, "inventory unavailable")
                    } else {
                        CmdOutput::success("1 1 S\n")
                    },
                );
            }
        }
        if mode == "wrong_bundle" {
            mock.expect_run(
                "plutil",
                CmdOutput::success("{\"CFBundleIdentifier\":\"wrong.app\"}"),
            );
        }
        if mode == "unsupported_launcher" {
            mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
            mock.expect_run("vtool", CmdOutput::success("platform IOSSIMULATOR\n"));
            mock.expect_run("otool -L", CmdOutput::success("test.app/binary:\n"));
            mock.expect_run("nm", CmdOutput::success("_main\n"));
        }
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Failed, "{mode}");
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::BuildFailed,
            "{mode}"
        );
        assert_eq!(mock.remaining(), 0, "{mode}");
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "simctl-install" | "simctl-launch" | "core-walk"
        )));
        if workspace {
            assert!(!labels(&mock)
                .iter()
                .any(|l| matches!(l.as_str(), "expo-run-ios" | "expo-ios-build-help")));
        }
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(
            record.resources.build_process().is_some(),
            retained,
            "{mode}"
        );
        assert_eq!(record.resources.lease.is_some(), retained, "{mode}");
        assert_eq!(record.resources.build_lock.is_some(), retained, "{mode}");
        assert_eq!(
            req.lock_root.join("native-build-ios").exists(),
            retained,
            "{mode}"
        );
        assert!(record.resources.metro.is_none());
        assert_eq!(
            mock.piped_stdin_text(0),
            if mode == "unknown_identity" {
                ""
            } else {
                "start\n"
            }
        );
        if mode == "timeout" {
            assert!(
                receipt.timings_ms["total"]
                    >= qaren::scenario::Deadlines::default().build_seconds * 1000
            );
            assert!(
                receipt.timings_ms["total"]
                    < (qaren::scenario::Deadlines::default().build_seconds + 5) * 1000
            );
        }
        assert!(record.build.unwrap().artifact.is_none());
        if workspace && mode != "unknown_identity" {
            let run_dir = req.runs_root.join(run_id());
            assert_xcode_products_retained(&run_dir);
        }
    }
}

#[test]
fn workspace_changed_by_clean_prebuild_refuses_before_creating_output_or_building() {
    for symlink in [false, true] {
        let (repo, app) = app_repo();
        common::write_ios_workspace(&app, "ios/Native.xcworkspace");
        configure_workspace(&app, "ios/Native.xcworkspace", "Native");
        let req = request(&repo, &app, 30);
        common::append_registry_config(&req.config_path);
        let mut mock = MockRunner::new();
        let path = app.join("ios/Native.xcworkspace");
        mock.workspace_mutation = Some(if symlink {
            common::WorkspaceMutation::Symlink(path)
        } else {
            common::WorkspaceMutation::Remove(path)
        });
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(""));
        script_clean_build_plan(&mut mock);
        mock.expect_spawn_piped("expo prebuild", 5000, "", Some(0));
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("qaren-build"));
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

        let receipt = run(&mut mock, &req);

        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{:?}",
            receipt.failure
        );
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::IosBuildCapabilityUnavailable
        );
        assert_eq!(mock.remaining(), 0);
        common::assert_registry_specs(&mock.calls);
        assert_eq!(mock.piped_stdin_text(0), "start\n");
        assert!(!req.runs_root.join(run_id()).join("ios-build").exists());
        assert!(!labels(&mock).iter().any(|l| matches!(
            l.as_str(),
            "xcodebuild-ios" | "expo-run-ios" | "simctl-install" | "expo-start" | "simctl-launch"
        )));
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.lease.is_none());
        assert!(record.resources.build_lock.is_none());
    }
}

fn booted_json() -> String {
    format!(
        r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"udid":"{UDID}","name":"qa-company-app","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}}]}}}}"#
    )
}

fn df_ok() -> CmdOutput {
    CmdOutput::success(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 976490576 400000000 500000000 45% /\n",
    )
}

const IOS_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];

// Everything up to and including the lease: preflight, device, candidate, prereqs, port, disk, self identity.
fn script_preflight(mock: &mut MockRunner, repo: &Path) {
    script_preflight_inventory(mock, repo, "simctl list devices booted", &booted_json());
}

fn script_preflight_inventory(mock: &mut MockRunner, repo: &Path, command: &str, inventory: &str) {
    script_preflight_inventory_until_lease(mock, repo, command, inventory);
    mock.expect_run("lsof", free_port());
}

fn script_preflight_until_lease(mock: &mut MockRunner, repo: &Path) {
    script_preflight_inventory_until_lease(
        mock,
        repo,
        "simctl list devices booted",
        &booted_json(),
    );
}

// Everything up to the lease claim; the Metro port is checked only after the lease is held.
fn script_preflight_inventory_until_lease(
    mock: &mut MockRunner,
    repo: &Path,
    command: &str,
    inventory: &str,
) {
    script_preflight_with_status(mock, repo, command, inventory, UNTRACKED_PLAN);
}

const UNTRACKED_PLAN: &str = "?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0";

fn script_preflight_with_status(
    mock: &mut MockRunner,
    repo: &Path,
    command: &str,
    inventory: &str,
    status: &str,
) {
    script_preflight_to_pnpm(
        mock,
        repo,
        command,
        inventory,
        status,
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("qaren check\n")); // self command
}

fn script_preflight_to_pnpm(
    mock: &mut MockRunner,
    repo: &Path,
    command: &str,
    inventory: &str,
    status: &str,
    pnpm_output: CmdOutput,
) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(mock, repo);
    mock.expect_run(command, CmdOutput::success(inventory));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // toplevel of cwd
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // explicit worktree
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(status));
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run("QAREN_PNPM_LAUNCH_GROUP", pnpm_output);
}

#[test]
fn incompatible_pnpm_refuses_before_claim_install_or_metro_launch() {
    for output in [CmdOutput::failed(1, ""), CmdOutput::success("unproven\n")] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_to_pnpm(
            &mut mock,
            &repo,
            "simctl list devices booted",
            &booted_json(),
            UNTRACKED_PLAN,
            output,
        );
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert!(FailureCode::PnpmProcessGroupUnsupported.is_refusal());
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::PnpmProcessGroupUnsupported);
        assert!(failure.next_action.contains("installed pnpm executable"));
        assert_eq!(mock.remaining(), 0);
        assert!(mock.spawned_logs.is_empty());
        assert!(!repo.join(".locks").exists());
        assert!(!mock.calls.iter().any(|spec| spec.label == "pnpm-install"));
    }
}

fn probe_timed_out() -> CmdOutput {
    CmdOutput {
        timed_out: true,
        duration_ms: 30_000,
        ..Default::default()
    }
}

#[test]
fn busy_host_probe_timeout_refuses_with_its_own_code() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("QAREN_PNPM_LAUNCH_GROUP".into(), 30_000));
    script_preflight_to_pnpm(
        &mut mock,
        &repo,
        "simctl list devices booted",
        &booted_json(),
        UNTRACKED_PLAN,
        probe_timed_out(),
    );
    mock.expect_run("QAREN_PNPM_LAUNCH_GROUP", probe_timed_out());
    mock.expect_run("QAREN_PNPM_LAUNCH_GROUP", probe_timed_out());
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(FailureCode::PnpmProbeTimedOut.is_refusal());
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(
        serde_json::to_value(failure.code).unwrap(),
        "PNPM_PROBE_TIMED_OUT"
    );
    assert!(failure.detail.contains("3 attempt"), "{}", failure.detail);
    assert!(failure.next_action.contains("less loaded"));
    assert!(!failure.next_action.contains("pnpm version"));
    let probe_bounds: Vec<u64> = mock
        .calls
        .iter()
        .filter(|spec| spec.label == "pnpm-group-probe")
        .map(|spec| spec.timeout_seconds)
        .collect();
    assert_eq!(probe_bounds, [30, 60, 120]);
    assert_eq!(mock.remaining(), 0);
    assert!(!repo.join(".locks").exists());
    assert!(!mock.calls.iter().any(|spec| spec.label == "pnpm-install"));
}

#[test]
fn probe_timeout_once_then_proved_continues_and_records_the_retry() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_to_pnpm(
        &mut mock,
        &repo,
        "simctl list devices booted",
        &booted_json(),
        UNTRACKED_PLAN,
        probe_timed_out(),
    );
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("qaren check\n")); // self command
    mock.expect_run("lsof", free_port());
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt.outcomes["pnpm-group-probe_attempt_1"].starts_with("timed out after 30000ms"));
    assert_eq!(
        receipt.outcomes["pnpm-group-probe_attempt_2"],
        "process group proved; timeout_seconds=60"
    );
    assert_eq!(receipt.timings_ms["pnpm-group-probe_attempt_1"], 30_000);
}

#[test]
fn probe_budget_exhaustion_stops_before_the_last_attempt() {
    let (repo, app) = app_repo();
    let config = app.join(".qaren").join("config.yaml");
    let mut yaml = std::fs::read_to_string(&config).unwrap();
    yaml.push_str("deadlines:\n  install_deps_seconds: 60\n");
    std::fs::write(&config, yaml).unwrap();
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("QAREN_PNPM_LAUNCH_GROUP".into(), 30_000));
    script_preflight_to_pnpm(
        &mut mock,
        &repo,
        "simctl list devices booted",
        &booted_json(),
        UNTRACKED_PLAN,
        probe_timed_out(),
    );
    mock.expect_run("QAREN_PNPM_LAUNCH_GROUP", probe_timed_out());
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::PnpmProbeTimedOut);
    assert!(failure.detail.contains("2 attempt"), "{}", failure.detail);
    let probe_bounds: Vec<u64> = mock
        .calls
        .iter()
        .filter(|spec| spec.label == "pnpm-group-probe")
        .map(|spec| spec.timeout_seconds)
        .collect();
    assert_eq!(probe_bounds, [30, 29]);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn installed_dependencies_can_replace_a_compatible_cli_and_refuse_before_boot_or_reset() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    qaren::adapters::ios::require_build(&mut mock, &app, None).unwrap();
    script_preflight_inventory(
        &mut mock,
        &repo,
        "simctl list devices -j",
        &available_inventory("Shutdown"),
    );
    script_admission(&mut mock);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success("--no-bundler\n--device [device]\n"),
    );
    let mut runner = LeaseObservedRunner {
        mock,
        repo: repo.clone(),
        wire: None,
        observed: Vec::new(),
        expect_fresh_install: true,
    };
    let mut req = request(&repo, &app, 30);
    req.boot_device = true;
    req.fresh_install = true;
    req.device = Some(UDID.into());

    let receipt = run(&mut runner, &req);

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::IosBuildCapabilityUnavailable
    );
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(runner.mock.remaining(), 0);
    assert_eq!(
        runner.observed,
        [
            "fresh-install-admission",
            "pnpm-install",
            "expo-ios-build-help"
        ]
    );
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(record.resources.lease.is_none());
    assert!(record.resources.fresh_install.is_none());
    assert!(record.build.is_none());
}

#[test]
fn missing_ios_build_capability_after_install_refuses_before_reset_or_boot() {
    for output in [
        CmdOutput::success("--no-bundler\n-d, --device [device]\n"),
        CmdOutput::failed(127, "PRIVATE_CLI_MISSING"),
        CmdOutput {
            timed_out: true,
            stdout: "PRIVATE_PROMPT".into(),
            ..Default::default()
        },
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices -j",
            &available_inventory("Shutdown"),
        );
        script_admission(&mut mock);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("expo run:ios --help", output);
        let mut req = request(&repo, &app, 30);
        req.boot_device = true;
        req.fresh_install = true;
        req.device = Some(UDID.into());
        let config = std::fs::read(&req.config_path).unwrap();
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            serde_json::to_value(receipt.failure.as_ref().unwrap().code).unwrap(),
            "IOS_BUILD_CAPABILITY_UNAVAILABLE"
        );
        assert_eq!(mock.remaining(), 0);
        assert!(!receipt.to_json().contains("PRIVATE_"));
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.lease.is_none());
        assert!(record.resources.fresh_install.is_none());
        assert!(record.build.is_none());
        assert!(!labels(&mock).iter().any(|l| matches!(
            l.as_str(),
            "simctl-bootstatus" | "simctl-listapps" | "simctl-uninstall" | "expo-run-ios"
        )));
        assert_eq!(std::fs::read(&req.config_path).unwrap(), config);
    }
}

// deps → build plan → build → readiness → provenance recheck, then the core child spawn identity.
fn script_provision(mock: &mut MockRunner) {
    common::script_ios_deps(mock);
    script_provision_after_deps(mock);
}

fn script_provision_after_deps(mock: &mut MockRunner) {
    script_provision_build(mock, "expo run:ios", "");
}

fn script_provision_build(mock: &mut MockRunner, command: &str, native_files: &str) {
    script_provision_candidate(mock, command, native_files, &"b".repeat(40), UNTRACKED_PLAN);
}

fn script_provision_candidate(
    mock: &mut MockRunner,
    command: &str,
    native_files: &str,
    head: &str,
    status: &str,
) {
    mock.expect_run("ls-files", CmdOutput::success(native_files));
    script_clean_build_plan(mock);
    common::script_finite_ios_build_with(mock, command, |m| {
        m.expect_run("rev-parse HEAD", CmdOutput::success(head));
        m.expect_run("--porcelain", CmdOutput::success(status));
        script_fingerprint_recheck(m, native_files)
    });
    script_ready_recheck(mock, native_files);
}

fn script_candidate_recheck(mock: &mut qaren::exec::MockRunner) {
    mock.expect_run("rev-parse HEAD", CmdOutput::success(&"b".repeat(40)));
    mock.expect_run("--porcelain", CmdOutput::success(UNTRACKED_PLAN));
}

fn script_fingerprint_recheck(mock: &mut qaren::exec::MockRunner, native_files: &str) {
    mock.expect_run("ls-files", CmdOutput::success(native_files));
    common::script_xcode(mock);
}

// A clean iOS build re-reads free disk after the build plan.
fn script_clean_build_plan(mock: &mut MockRunner) {
    common::script_xcode(mock);
    mock.expect_run("df", df_ok());
}

fn script_ready_recheck(mock: &mut MockRunner, native_files: &str) {
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
    mock.expect_run("ls-files", CmdOutput::success(native_files)); // fingerprint recheck
    common::script_xcode(mock);
}

// The app-root status the walk's worktree drift is measured against, before and after the core.
fn script_drift_status(mock: &mut MockRunner) {
    mock.expect_run("(exclude).qaren/actions", CmdOutput::success(""));
}

fn script_core_identity(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:02:00 2026\n")); // core lstart
    mock.expect_run("ps", CmdOutput::success("node walk.js\n")); // core command
}

// Drift report (git head + status), then the Metro group teardown: alive, TERM, KILL, gone, port free.
fn script_teardown(mock: &mut MockRunner) {
    script_teardown_core(mock, CmdOutput::success("1 1 S\n6000 6000 S\n"), false);
}

fn hosts_absent() -> CmdOutput {
    CmdOutput::success("PID\tStatus\tLabel\n1\t0\tcom.apple.SpringBoard\n")
}

fn script_host_probe(mock: &mut MockRunner, udid: &str, output: CmdOutput) {
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Booted")),
    );
    mock.expect_run(&format!("simctl spawn {udid} launchctl list"), output);
}

fn script_teardown_core(mock: &mut MockRunner, inventory: CmdOutput, probe_dead_leader: bool) {
    script_teardown_core_host(
        mock,
        inventory,
        probe_dead_leader,
        UDID,
        Some(hosts_absent()),
    );
}

// After the core and Metro groups, observe both hosts on the exact leased simulator.
fn script_teardown_core_host(
    mock: &mut MockRunner,
    inventory: CmdOutput,
    probe_dead_leader: bool,
    udid: &str,
    runner_host: Option<CmdOutput>,
) {
    script_drift_status(mock);
    script_teardown_after_drift(mock, inventory, probe_dead_leader, udid, runner_host);
}

fn script_teardown_after_drift(
    mock: &mut MockRunner,
    inventory: CmdOutput,
    probe_dead_leader: bool,
    udid: &str,
    runner_host: Option<CmdOutput>,
) {
    script_teardown_with_status(
        mock,
        UNTRACKED_PLAN,
        inventory,
        probe_dead_leader,
        udid,
        runner_host,
    );
}

fn script_teardown_with_status(
    mock: &mut MockRunner,
    status: &str,
    inventory: CmdOutput,
    probe_dead_leader: bool,
    udid: &str,
    runner_host: Option<CmdOutput>,
) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(status));
    script_teardown_resources(mock, inventory, probe_dead_leader, udid, runner_host);
}

fn script_final_verification(mock: &mut MockRunner) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
}

fn script_teardown_resources(
    mock: &mut MockRunner,
    inventory: CmdOutput,
    probe_dead_leader: bool,
    udid: &str,
    runner_host: Option<CmdOutput>,
) {
    mock.expect_run("ps -A", inventory.clone());
    if probe_dead_leader {
        mock.expect_run("ps -p 9000", CmdOutput::failed(1, ""));
        mock.expect_run("ps -A", inventory);
    }
    script_metro_teardown(mock, udid, runner_host);
}

fn script_metro_teardown(mock: &mut MockRunner, udid: &str, runner_host: Option<CmdOutput>) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    if let Some(runner_host) = runner_host {
        script_host_probe(mock, udid, runner_host);
    }
}

fn envelope(seq: u64, kind: &str, payload: &str) -> String {
    format!(
        r#"{{"v":1,"runId":"{}","seq":{seq},"type":"{kind}","payload":{payload}}}"#,
        run_id()
    )
}

fn row(line: u64, kind: &str) -> String {
    format!(
        r#"{{"block":"plan","line":{line},"attempt":1,"kind":"{kind}","resolvedBy":"exact","screenshot":"screenshots/{line:02}.png","t":{},"outcome":"pass"}}"#,
        line * 100
    )
}

// Streamed rows are value-free; only the result ledger carries the core's projected text.
fn projected(row: &str, text: &str) -> String {
    format!(
        "{},\"text\":{}}}",
        row.trim_end_matches('}'),
        serde_json::to_string(text).unwrap()
    )
}

fn pass_stdout() -> String {
    let rows = [row(1, "step"), row(2, "check")];
    let steps = [
        projected(&rows[0], "1. Tap \"Tasks\""),
        projected(&rows[1], "✓ \"Tasks\""),
    ];
    let ledger = format!(
        r#"{{"verdict":"PASS","path":"walk","blocks":[{{"key":"plan","outcome":"pass","source":"discovered"}}],"steps":[{}],"jev":{{"calls":0,"medianMs":0}},"llmTurns":0,"escapes":0,"recoveries":0}}"#,
        steps.join(",")
    );
    format!(
        "{}\n{}\n{}\n{}\n",
        envelope(2, "admitted", "{}"),
        envelope(3, "row", &rows[0]),
        envelope(4, "row", &rows[1]),
        envelope(5, "result", &ledger)
    )
}

fn labels(mock: &MockRunner) -> Vec<String> {
    mock.calls.iter().map(|c| c.label.clone()).collect()
}

fn assert_subsequence(haystack: &[String], needles: &[&str]) {
    let mut at = 0;
    for needle in needles {
        match haystack[at..].iter().position(|l| l == needle) {
            Some(i) => at += i + 1,
            None => panic!("{needle} missing after position {at} in {haystack:?}"),
        }
    }
}

fn assert_direct_ios_launch(mock: &MockRunner) {
    let position = |label: &str| mock.calls.iter().position(|c| c.label == label).unwrap();
    assert!(position("ios-app-info") < position("simctl-install"));
    assert!(position("ios-app-platform") < position("simctl-install"));
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.args.iter().any(|a| a == "openurl")));
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
    assert_subsequence(
        &labels(mock),
        &[
            "expo-start",
            "simctl-install",
            "metro-status",
            "simctl-launch",
            "metro-status",
            "simctl-app-container",
            "simctl-launchctl",
            "core-walk",
        ],
    );
}

fn script_recipe_walk(mock: &mut MockRunner, repo: &Path, ledger: &str, exit: i32) {
    script_preflight(mock, repo);
    script_recipe_walk_after_preflight(mock, ledger, exit, UNTRACKED_PLAN);
}

fn script_recipe_walk_on_default_branch(
    mock: &mut MockRunner,
    repo: &Path,
    ledger: &str,
    exit: i32,
) {
    script_preflight_with_status(mock, repo, "simctl list devices booted", &booted_json(), "");
    mock.expect_run("lsof", free_port());
    script_recipe_walk_after_preflight(mock, ledger, exit, "");
    mock.expect_run(
        "refs/remotes/origin/HEAD",
        CmdOutput::success(&format!("{}\n", "b".repeat(40))),
    );
}

fn script_recipe_walk_after_preflight(
    mock: &mut MockRunner,
    ledger: &str,
    exit: i32,
    status: &str,
) {
    common::script_ios_deps(mock);
    script_provision_candidate(mock, "expo run:ios", "", &"b".repeat(40), status);
    mock.expect_run("(exclude).qaren/actions", CmdOutput::success(""));
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", ledger)),
        Some(exit),
    );
    script_core_identity(mock);
    mock.expect_run("(exclude).qaren/actions", CmdOutput::success(""));
    script_teardown_with_status(
        mock,
        status,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        UDID,
        Some(hosts_absent()),
    );
}

fn run_saved_plan_on_default_branch(
    failure: &str,
) -> (qaren::receipt::Receipt, PathBuf, &'static str) {
    let (repo, app) = app_repo();
    let book = app.join(".qaren/plans");
    std::fs::create_dir_all(&book).unwrap();
    let plan = "1. Tap \"Tasks\"\n✓ \"Tasks\"\n";
    let saved = book.join("tasks.md");
    std::fs::write(&saved, plan).unwrap();
    let mut mock = MockRunner::new();
    let ledger = format!(
        r#"{{"verdict":"FAIL","path":"walk","blocks":[{{"key":"plan","outcome":"fail","source":"discovered"}}],"steps":[],"jev":{{"calls":0,"medianMs":0}},"llmTurns":0,"escapes":0,"recoveries":0,"failure":{failure}}}"#
    );
    script_recipe_walk_on_default_branch(&mut mock, &repo, &ledger, 1);
    let mut req = request(&repo, &app, 30);
    req.plan_file = saved.clone();

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Fail, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    (receipt, saved, plan)
}

#[test]
fn a_saved_plan_whose_step_fails_on_the_default_branch_is_flagged_for_that_platform() {
    let (receipt, saved, plan) =
        run_saved_plan_on_default_branch(r#"{"step":2,"seen":"no Tasks","kind":"step"}"#);

    assert_eq!(
        receipt.recipe.map(|recipe| recipe.outcome),
        Some(qaren::recipes::Outcome::Flagged)
    );
    assert_eq!(
        std::fs::read_to_string(&saved).unwrap(),
        format!("<!-- qaren:broken ios -->\n{plan}")
    );
}

#[test]
fn a_saved_plan_that_fails_without_a_step_failure_on_the_default_branch_is_left_unmarked() {
    let (receipt, saved, plan) = run_saved_plan_on_default_branch(
        r#"{"step":1,"seen":"JEV_UNAVAILABLE: the judgment service is unavailable"}"#,
    );

    assert_eq!(
        receipt.recipe,
        Some(qaren::recipes::RecipeOutcome {
            outcome: qaren::recipes::Outcome::NotMarked,
            path: None,
            reason: Some("not a definite step failure".into()),
        })
    );
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), plan);
}

#[test]
fn a_flagged_saved_plan_that_passes_on_the_default_branch_is_cleared_not_resaved() {
    let (repo, app) = app_repo();
    let book = app.join(".qaren/plans");
    std::fs::create_dir_all(&book).unwrap();
    let plan = "## QA\n\n### plan\n1. Tap \"Tasks\"\n";
    let saved = book.join("tasks.md");
    let flagged = format!("<!-- qaren:broken ios -->\n{plan}");
    std::fs::write(&saved, &flagged).unwrap();
    std::fs::write(app.join("plan.md"), &flagged).unwrap();
    let mut mock = MockRunner::new();
    let ledger = r###"{"verdict":"PASS","path":"walk","blocks":[{"key":"plan","outcome":"pass","source":"discovered"}],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0,"recipe":{"slug":"plan","markdown":"## QA\n\n### plan\n1. Tap \"Tasks\"\n"}}"###;
    script_recipe_walk_on_default_branch(&mut mock, &repo, ledger, 0);
    let mut req = request(&repo, &app, 30);
    req.plan_file = saved.clone();

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        receipt.recipe.map(|recipe| recipe.outcome),
        Some(qaren::recipes::Outcome::Cleared)
    );
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), plan);
    assert!(!book.join("plan.md").exists());
}

#[test]
fn a_fully_passing_draft_is_saved_into_the_plan_book_and_kept_out_of_run_evidence() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    let ledger = r###"{"verdict":"PASS","path":"walk","blocks":[{"key":"plan","outcome":"pass","source":"discovered"}],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0,"recipe":{"slug":"plan","markdown":"## QA\n\n### plan\n1. Tap \"Tasks\"\n"}}"###;
    script_recipe_walk(&mut mock, &repo, ledger, 0);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    let saved = app.canonicalize().unwrap().join(".qaren/plans/plan.md");
    assert_eq!(
        receipt.recipe,
        Some(qaren::recipes::RecipeOutcome {
            outcome: qaren::recipes::Outcome::Saved,
            path: Some(saved.clone()),
            reason: None,
        })
    );
    assert_eq!(
        std::fs::read_to_string(&saved).unwrap(),
        "## QA\n\n### plan\n1. Tap \"Tasks\"\n"
    );
    let evidence = std::fs::read_to_string(&receipt.artifacts["ledger"]).unwrap();
    assert!(!evidence.contains("recipe"), "{evidence}");
}

#[test]
fn a_saved_plan_that_fails_on_local_changes_is_left_unmarked() {
    let (repo, app) = app_repo();
    let book = app.join(".qaren/plans");
    std::fs::create_dir_all(&book).unwrap();
    let plan = "1. Tap \"Tasks\"\n✓ \"Tasks\"\n";
    std::fs::write(book.join("tasks.md"), plan).unwrap();
    let mut mock = MockRunner::new();
    let ledger = r#"{"verdict":"FAIL","path":"walk","blocks":[{"key":"plan","outcome":"fail","source":"discovered"}],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0,"failure":{"step":2,"seen":"no Tasks"}}"#;
    script_recipe_walk(&mut mock, &repo, ledger, 1);
    let mut req = request(&repo, &app, 30);
    req.plan_file = book.join("tasks.md");

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Fail, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        receipt.recipe,
        Some(qaren::recipes::RecipeOutcome {
            outcome: qaren::recipes::Outcome::NotMarked,
            path: None,
            reason: Some("local changes".into()),
        })
    );
    assert_eq!(
        std::fs::read_to_string(book.join("tasks.md")).unwrap(),
        plan
    );
}

#[test]
fn the_receipt_names_written_blocks_and_paths_the_walk_changed_outside_them() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    mock.expect_run(
        "(exclude).qaren/actions",
        CmdOutput::success(" M test-app/dirty.ts\0"),
    );
    let ledger = r#"{"verdict":"PASS","path":"replay","blocks":[{"key":"plan","outcome":"pass","source":"replayed"},{"key":"pin","outcome":"pass","source":"replayed","saved":false,"unsavable":"line 4: fills a private input"}],"blocksWritten":["plan"],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0}"#;
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", ledger)),
        Some(0),
    );
    script_core_identity(&mut mock);
    mock.expect_run(
        "(exclude).qaren/actions",
        CmdOutput::success(" M test-app/dirty.ts\0?? test-app/src/new.ts\0"),
    );
    script_final_verification(&mut mock);
    mock.expect_run(
        "--git-common-dir",
        CmdOutput::failed(128, "not a git checkout"),
    );
    script_teardown_resources(
        &mut mock,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        UDID,
        Some(hosts_absent()),
    );

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.blocks_written, vec!["plan".to_string()]);
    assert_eq!(
        receipt.blocks_not_saved,
        vec![qaren::receipt::BlockNotSaved {
            block: "pin".to_string(),
            reason: "line 4: fills a private input".to_string(),
        }]
    );
    assert_eq!(
        receipt.worktree_drift,
        vec!["test-app/src/new.ts".to_string()]
    );
    assert_eq!(receipt.ledger.as_ref().unwrap().path, "replay");
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["ledger"]["blocks"],
        serde_json::json!({
            "replayed": 2, "patched": 0, "discovered": 0,
        })
    );
    let status = mock
        .calls
        .iter()
        .find(|c| c.rendered().contains("(exclude).qaren/actions"))
        .unwrap();
    assert!(status
        .rendered()
        .contains(&app.canonicalize().unwrap().to_string_lossy().into_owned()));
}

#[test]
fn checks_started_three_milliseconds_apart_claim_separate_runs() {
    let (first_repo, first_app) = app_repo();
    let runs_root = first_repo.join("runs");
    let mut receipts = Vec::new();
    for index in 0..2 {
        let (repo, app) = if index == 0 {
            (first_repo.clone(), first_app.clone())
        } else {
            app_repo()
        };
        let mut req = request(&repo, &app, 30);
        req.runs_root = runs_root.clone();
        let mut mock = MockRunner::new();
        mock.sleep(std::time::Duration::from_millis(index * 3));
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        let expected_id = if index == 0 {
            run_id()
        } else {
            format!("{}-000001", run_id())
        };
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &pass_stdout().replace(&run_id(), &expected_id),
            Some(0),
        );
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        receipts.push(receipt);
    }
    assert_ne!(receipts[0].run_id, receipts[1].run_id);
    for receipt in receipts {
        let record = RunRecord::load(&runs_root, &receipt.run_id).unwrap();
        assert_eq!(record.phase, Phase::Cleaned);
        assert_eq!(record.terminal.unwrap().verdict, "PASS");
        assert!(Path::new(&receipt.artifacts["report"]).is_file());
        let mut reader = qaren::exec::MockRunner::new();
        let status = qaren::commands::status::status(&mut reader, &runs_root, &receipt.run_id);
        assert_eq!(status.result, ReceiptResult::Cleaned);
        let cleanup = qaren::commands::cleanup::cleanup(&mut reader, &runs_root, &receipt.run_id);
        assert_eq!(
            cleanup.result,
            ReceiptResult::Cleaned,
            "{:?}",
            cleanup.failure
        );
    }
}

#[test]
fn simultaneous_checks_on_distinct_devices_do_not_collide_at_the_same_millisecond() {
    let root = common::temp_repo();
    let occupied = root.join("runs").join(run_id());
    std::fs::create_dir_all(&occupied).unwrap();
    std::fs::write(occupied.join("canary"), "foreign evidence").unwrap();
    let occupied_file = root.join("runs").join(format!("{}-000001", run_id()));
    std::fs::write(&occupied_file, "foreign occupant").unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut workers = Vec::new();
    for index in 0..8 {
        let (repo, app) = app_repo();
        let udid = format!("{index:08}-51DA-4C4F-ACA1-39881C916FDD");
        let mut req = request(&repo, &app, 30);
        req.runs_root = root.join("runs");
        req.lock_root = root.join("locks");
        req.device = Some(udid.clone());
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices booted",
            &booted_json().replace(UDID, &udid),
        );
        mock.expect_run(
            "pnpm install --frozen-lockfile",
            CmdOutput::failed(1, "fixture stop"),
        );
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            let receipt = run(&mut mock, &req);
            assert_eq!(
                receipt.failure.as_ref().unwrap().code,
                FailureCode::DepsInstallFailed
            );
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(mock.remaining(), 0);
            RunRecord::load(&req.runs_root, &receipt.run_id).unwrap();
            receipt.run_id
        }));
    }
    let ids: std::collections::BTreeSet<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(ids.len(), 8);
    assert_eq!(
        std::fs::read_to_string(occupied.join("canary")).unwrap(),
        "foreign evidence"
    );
    assert_eq!(
        std::fs::read_to_string(occupied_file).unwrap(),
        "foreign occupant"
    );
}

#[test]
fn check_runs_the_phases_in_order_and_ends_pass_with_a_report() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_direct_ios_launch(&mock);
    assert_eq!(receipt.verb, "check");
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-ios")
        .unwrap();
    assert_eq!(build.program, "/bin/bash");
    assert_eq!(
        build.timeout_seconds,
        qaren::scenario::Deadlines::default().build_seconds
    );
    assert!(build.args[3].ends_with("exec \"$@\" >&2"));
    assert!(build.env.contains(&("BASH_ENV".into(), "/dev/null".into())));
    assert!(build.env.contains(&("TYPESAFE_API_KEY".into(), "".into())));
    assert_eq!(receipt.run_id, run_id());
    assert!(!labels(&mock).iter().any(|l| matches!(
        l.as_str(),
        "fresh-install-admission" | "simctl-listapps" | "simctl-uninstall" | "simctl-bootstatus"
    )));
    assert_subsequence(
        &labels(&mock),
        &[
            "node-version",
            "plan-preflight",
            "simctl-list-booted",
            "git-toplevel",
            "which",
            "df",
            "ps-lstart",
            "lsof-port",
            "pnpm-install",
            "expo-ios-build-help",
            "git-ls-files",
            "expo-run-ios",
            "metro-status",
            "core-walk",
            "kill-group",
        ],
    );
    let ledger = receipt.ledger.as_ref().unwrap();
    assert_eq!(ledger.verdict, "PASS");
    assert_eq!(ledger.steps, 2);
    assert_eq!(ledger.jev_calls, 0);
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(
        receipt.cleanup.get("core").map(String::as_str),
        Some("absent")
    );
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(receipt.outcomes["candidate_drift"], "none");
    assert!(!receipt.outcomes.contains_key("pnpm-group-probe_attempt_1"));

    let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
    assert!(report.starts_with("# QaReN check: PASS"));
    assert!(
        report.contains("- ✓ line 1: 1. Tap \"Tasks\"\n"),
        "{report}"
    );
    assert!(report.contains("- ✓ line 2: ✓ \"Tasks\"\n"), "{report}");
    assert!(
        report.contains("  ![line 1](screenshots/01.png)\n"),
        "{report}"
    );
    assert!(report.contains("jev.calls 0"));

    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    let evidence = record.resources.core_cleanup.as_ref().unwrap();
    assert_eq!(evidence.run_id, run_id());
    assert_eq!(evidence.pgid, 9000);
    assert_eq!(
        evidence.outcome,
        qaren::runrecord::GroupCleanupResult::Absent
    );
    assert_eq!(
        serde_json::to_value(&receipt.core_cleanup).unwrap(),
        serde_json::to_value(evidence).unwrap()
    );
    assert!(record.resources.core.is_none());
    assert!(record.resources.device_borrowed);
    assert!(
        record.resources.lease.is_none(),
        "the lease is released after teardown"
    );
    assert!(record.resources.metro.is_none());
    assert_eq!(record.resources.ios_simulator.as_ref().unwrap().udid, UDID);
    assert!(!repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());

    // The child ran in the app root with the lease and Metro port in its environment.
    let core = mock.calls.iter().find(|c| c.label == "core-walk").unwrap();
    assert_eq!(core.cwd.as_deref(), Some(app.as_path()));
    assert!(core.env.iter().any(|(k, _)| k == "QAREN_DEVICE_LEASE"));
    assert!(core
        .env
        .iter()
        .any(|(k, v)| k == "QAREN_METRO_PORT" && v == "8791"));
    let request_line: serde_json::Value =
        serde_json::from_str(mock.piped_stdin_text(1).trim()).unwrap();
    assert_eq!(request_line["payload"]["appId"], "com.rndevagent.testapp");
    assert_eq!(request_line["payload"]["target"]["deviceId"], UDID);
    assert_eq!(
        request_line["payload"]["target"]["deviceName"],
        "qa-company-app"
    );
    let bundle_requests = &request_line["payload"]["target"]["metroBundleRequests"];
    assert_eq!(bundle_requests["atLaunch"], 0, "{bundle_requests}");
    assert!(bundle_requests["path"]
        .as_str()
        .unwrap()
        .ends_with("/logs/metro.bundle-requests"));
    assert_eq!(
        request_line["payload"]["target"]["manifestWarm"],
        serde_json::json!({ "ms": 0, "attempts": 2 })
    );
    // Without an explicit lane opt-in the booted simulator's settings are never read or written.
    assert!(request_line["payload"]["target"].get("warmLane").is_none());
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.label.starts_with("simctl-lane")));
    assert!(receipt.lane.is_none());
    assert_eq!(
        request_line["payload"]["preflightCalls"],
        probe_json()["callDetails"]
    );
    assert_eq!(receipt.preflight_jev.as_ref().unwrap().calls, 1);
    for call in &mock.calls {
        assert!(!call.rendered().contains(TEST_KEY));
        assert!(!serde_json::to_string(call).unwrap().contains(TEST_KEY));
    }
    assert!(!mock.piped_stdin_text(1).contains(TEST_KEY));
    assert!(!receipt.to_json().contains(TEST_KEY));
    assert_eq!(
        request_line["payload"]["plan"],
        "1. Tap \"Tasks\"\n✓ \"Tasks\"\n"
    );
}

#[test]
fn a_deadline_overrun_fails_naming_the_walk_phase_and_still_tears_down() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    let one_row = format!(
        "{}\n{}\n",
        envelope(2, "admitted", "{}"),
        envelope(3, "row", &row(1, "step"))
    );
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let (receipt, events) = run_with_events(&mut mock, &request(&repo, &app, 5));

    assert_eq!(receipt.result, ReceiptResult::Fail);
    let trail = stage_trail(&events);
    assert_eq!(
        trail[trail.len() - 4..],
        [
            "steps running",
            "steps failed WALK_DEADLINE_EXCEEDED",
            "cleanup running",
            "cleanup passed",
        ],
        "{trail:?}"
    );
    let end = &events.last().unwrap()["payload"];
    assert_eq!(end["failureCode"], "WALK_DEADLINE_EXCEEDED");
    assert_eq!(end["cleanup"]["device_lease"], "removed");
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
    assert_eq!(failure.phase, "walk");
    assert!(failure.detail.contains("no ledger row within 5s"));
    assert!(
        failure.detail.contains("after line 1"),
        "{}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);
    assert!(*mock.piped_killed[1].lock().unwrap());
    assert_eq!(receipt.ledger.as_ref().unwrap().failed_step, Some(1));
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.lease.is_none());
}

#[test]
fn a_cancelled_walk_is_a_refusal_that_still_tears_down_and_releases_the_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    let evidence = serde_json::json!({"subreason":"selection_unverified","heldPress":"not_tried_unsafe","outsideTargetChange":false,"captures":2});
    let result =
        serde_json::json!({"verdict":"REFUSED","code":"RUN_CANCELLED","pressEvidence":evidence});
    let one_row = format!(
        "{}\n{}\n",
        envelope(2, "row", &row(1, "step")),
        envelope(3, "result", &result.to_string())
    );
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
    script_core_identity(&mut mock);
    script_teardown_resources(
        &mut mock,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        UDID,
        Some(hosts_absent()),
    );
    mock.cancel_after = Some(("-p 9000".into(), "received SIGTERM".into()));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled);
    assert_eq!(failure.phase, "walk");
    assert_eq!(failure.next_action.as_str(), "rerun_when_ready");
    assert!(failure.recovery.is_some());
    let durable: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt.artifacts["ledger"]).unwrap()).unwrap();
    assert_eq!(durable["pressEvidence"], evidence);
    assert!(
        failure.detail.contains("received SIGTERM"),
        "{}",
        failure.detail
    );
    assert!(
        *mock.piped_terminated[1].lock().unwrap(),
        "the core gets SIGTERM first so it can close its device session"
    );
    assert!(*mock.piped_killed[1].lock().unwrap());
    assert_eq!(receipt.ledger.as_ref().unwrap().verdict, "REFUSED");
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.lease.is_none());
}

fn script_cancelled_walk(mock: &mut MockRunner, repo: &Path, runner_host: CmdOutput) {
    script_preflight(mock, repo);
    script_provision(mock);
    let one_row = format!("{}\n", envelope(2, "row", &row(1, "step")));
    script_drift_status(mock);
    script_host_probe(mock, UDID, runner_host.clone());
    mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
    script_core_identity(mock);
    script_teardown_resources(
        mock,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        UDID,
        Some(runner_host),
    );
    mock.cancel_after = Some(("-p 9000".into(), "received SIGKILL of the caller".into()));
}

#[test]
fn absent_runner_hosts_release_the_lease_without_termination() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_cancelled_walk(&mut mock, &repo, hosts_absent());

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.cleanup["runner_host"], "absent");
    assert!(!receipt.outcomes.contains_key("runner_host_probe"));
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.args.iter().any(|a| a == "terminate")));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn an_unknown_runner_host_inventory_keeps_the_lease_for_cleanup() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_cancelled_walk(
        &mut mock,
        &repo,
        CmdOutput::failed(1, "CoreSimulatorService connection interrupted"),
    );
    for _ in 0..2 {
        script_host_probe(
            &mut mock,
            UDID,
            CmdOutput::failed(1, "CoreSimulatorService connection interrupted"),
        );
    }

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.outcomes["runner_host_probe"], "unknown");
    assert!(receipt.cleanup["runner_host"].starts_with("unresolved"));
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert!(
        record.resources.lease.is_some(),
        "the lease waits for qaren cleanup"
    );
}

fn host_present() -> CmdOutput {
    CmdOutput::success(
        "PID Status Label\n42 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner[abc][rb-legacy]\n",
    )
}

// The host was absent when the core started, so the one that survives a cancelled walk is the run's.
#[test]
fn a_cancelled_walk_waits_for_its_runner_host_without_terminating_it() {
    for (after, reads, runner_host, lease) in [
        (hosts_absent(), 1, "absent", "removed"),
        (host_present(), 3, "unresolved", "unresolved"),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        let one_row = format!("{}\n", envelope(2, "row", &row(1, "step")));
        mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
        script_core_identity(&mut mock);
        script_teardown_resources(
            &mut mock,
            CmdOutput::success("1 1 S\n6000 6000 S\n"),
            false,
            UDID,
            Some(host_present()),
        );
        for _ in 0..reads {
            script_host_probe(&mut mock, UDID, after.clone());
        }
        mock.cancel_after = Some(("-p 9000".into(), "received SIGTERM".into()));

        let receipt = run(&mut mock, &request(&repo, &app, 30));

        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::RunCancelled
        );
        assert!(receipt.cleanup["runner_host"].starts_with(runner_host));
        assert!(receipt.cleanup["device_lease"].starts_with(lease));
        assert!(mock
            .calls
            .iter()
            .all(|spec| spec.label != "simctl-terminate"));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn present_shared_runner_hosts_are_not_terminated_by_check_or_cleanup() {
    for bundle in [
        "dev.lykhoyda.rndevagent.fastrunner",
        "dev.lykhoyda.rndevagent.fastrunner.uitests.xctrunner",
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        let present = CmdOutput::success(&format!(
            "PID Status Label\n42 0 UIKitApplication:{bundle}[abc][rb-legacy]\n"
        ));
        script_cancelled_walk(&mut mock, &repo, present.clone());
        let req = request(&repo, &app, 30);
        let receipt = run(&mut mock, &req);
        assert!(receipt.cleanup["runner_host"].starts_with("unresolved"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
        assert!(!mock
            .calls
            .iter()
            .any(|c| c.args.iter().any(|a| a == "terminate")));
        assert_eq!(mock.remaining(), 0);
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        let owner_pid = record.prepare.as_ref().unwrap().pid;
        let lease = record.resources.lease.unwrap();
        let mut cleanup = MockRunner::new();
        cleanup.expect_run(
            &format!("ps -p {owner_pid} -o lstart="),
            CmdOutput::success(""),
        );
        script_host_probe(&mut cleanup, UDID, present);
        let receipt = qaren::commands::cleanup::cleanup(&mut cleanup, &req.runs_root, &run_id());
        assert!(receipt.cleanup["runner_host"].starts_with("unresolved"));
        assert!(lease.lock_dir.exists());
        assert!(cleanup
            .calls
            .iter()
            .all(|c| c.program != "/bin/kill" && !c.args.iter().any(|a| a == "terminate")));
        cleanup.expect_run(
            &format!("ps -p {owner_pid} -o lstart="),
            CmdOutput::success(""),
        );
        script_host_probe(&mut cleanup, UDID, hosts_absent());
        let receipt = qaren::commands::cleanup::cleanup(&mut cleanup, &req.runs_root, &run_id());
        assert_eq!(receipt.cleanup["runner_host"], "absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!lease.lock_dir.exists());
        assert_eq!(cleanup.remaining(), 0);
    }
}

#[test]
fn reclaiming_a_run_that_reached_the_walk_requires_scoped_host_absence() {
    let (repo, app) = app_repo();
    let held = plant_holder(&repo, |r| {
        r.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
            udid: UDID.into(),
            name: "qaren-check".into(),
            device_type: "iPhone 17".into(),
            runtime: "iOS 26.5".into(),
        });
        r.resources.core_cleanup = Some(qaren::runrecord::CoreCleanupEvidence {
            run_id: "check-earlier".into(),
            pgid: 9000,
            at: "2026-08-12T16:05:00Z".into(),
            outcome: qaren::runrecord::GroupCleanupResult::Absent,
        });
    });
    let mut mock = MockRunner::new();
    script_preflight_until_lease(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success(""));
    mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(""));
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_run("lsof", free_port());
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
    script_unknown_admission(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
    assert_eq!(mock.remaining(), 0);
    assert!(!held.lock_dir.exists());
}

#[test]
fn a_cancel_during_the_build_stops_it_with_proof_and_releases_both_locks() {
    let (repo, app) = app_repo();
    let req = request(&repo, &app, 30);
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    mock.expect_spawn_piped("expo run:ios", 5000, "", None);
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
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
    mock.cancel_after = Some(("-p 5000".into(), "received SIGINT".into()));

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled);
    assert_eq!(failure.phase, "build");
    assert!(failure.detail.contains("received SIGINT"));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.join("native-build-ios").exists());
}

#[test]
fn a_cancel_between_phases_stops_before_the_next_phase_and_releases_the_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.cancel_after = Some((
        "expo run:ios --help".into(),
        "the calling process exited".into(),
    ));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled);
    assert_eq!(failure.phase, "build");
    assert!(failure.detail.contains("the calling process exited"));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert!(record.resources.lease.is_none());
}

#[test]
fn a_leased_device_refuses_before_any_provisioning() {
    for boot in [false, true] {
        let (repo, app) = app_repo();
        let lock_root = repo.join(".locks");
        let mut holder = qaren::exec::MockRunner::new();
        let held = qaren::lease::acquire(
            &mut holder,
            &lock_root,
            Platform::Ios,
            UDID,
            "check-earlier",
            Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
        )
        .unwrap();

        let mut mock = MockRunner::new();
        if boot {
            script_preflight_inventory_until_lease(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory("Shutdown"),
            );
        } else {
            script_preflight_until_lease(&mut mock, &repo);
        }
        mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
        mock.expect_run("ps", CmdOutput::success("S\n"));

        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        req.boot_device = boot;
        req.device = Some(UDID.to_lowercase()).filter(|_| boot);
        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::DeviceBusy
        );
        assert_eq!(receipt.run_id, "none");
        assert_eq!(mock.remaining(), 0);
        assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
        assert!(!labels(&mock).iter().any(|l| matches!(
            l.as_str(),
            "fresh-install-admission"
                | "simctl-listapps"
                | "simctl-uninstall"
                | "simctl-bootstatus"
        )));
        assert!(
            !repo.join("runs").exists()
                || std::fs::read_dir(repo.join("runs"))
                    .unwrap()
                    .next()
                    .is_none()
        );
        assert_eq!(
            qaren::buildplan::read_holder(&held.lock_dir)
                .unwrap()
                .run_id,
            "check-earlier"
        );
    }
}

const EARLIER_BIRTH: &str = "Wed Aug 12 15:00:00 2026";

fn plant_holder(repo: &Path, edit: impl FnOnce(&mut RunRecord)) -> qaren::lease::Lease {
    let identity = common::identity(4242, EARLIER_BIRTH);
    let held = qaren::lease::acquire(
        &mut qaren::exec::MockRunner::new(),
        &repo.join(".locks"),
        Platform::Ios,
        UDID,
        "check-earlier",
        Some(identity.clone()),
    )
    .unwrap();
    let mut record = common::base_record(
        repo,
        &common::ios_scenario_yaml(8791),
        "check-earlier",
        Phase::Walking,
    );
    record.prepare = Some(identity);
    record.resources.lease = Some(held.clone());
    record.resources.device_borrowed = true;
    edit(&mut record);
    record.save(&repo.join("runs")).unwrap();
    held
}

fn script_unknown_admission(mock: &mut MockRunner) {
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":"unknown"})
                .to_string(),
        ),
    );
}

#[test]
fn a_dead_holders_run_is_cleaned_up_and_its_lease_reclaimed_without_a_manual_step() {
    for holder_ps in ["", "Thu Aug 13 09:00:00 2026\n"] {
        let (repo, app) = app_repo();
        let held = plant_holder(&repo, |_| {});
        let mut mock = MockRunner::new();
        script_preflight_until_lease(&mut mock, &repo);
        mock.expect_run("ps", CmdOutput::success(holder_ps));
        mock.expect_run("lsof", free_port());
        mock.expect_run(
            "simctl list devices booted",
            CmdOutput::success(&booted_json()),
        );
        script_unknown_admission(&mut mock);
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.failure.as_ref().unwrap().phase, "fresh_install");
        assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(mock.remaining(), 0);
        let earlier = RunRecord::load(&req.runs_root, "check-earlier").unwrap();
        assert_eq!(earlier.phase, Phase::Cleaned);
        assert!(earlier.resources.lease.is_none());
        assert!(!held.lock_dir.exists());
    }
}

#[test]
fn a_dead_holder_without_a_matching_record_or_clean_proof_keeps_its_lease() {
    type Plant = Box<dyn Fn(&Path)>;
    let cases: [(&str, Plant); 3] = [
        (
            "no run record",
            Box::new(|repo: &Path| {
                plant_holder(repo, |_| {});
                std::fs::remove_dir_all(repo.join("runs/check-earlier")).unwrap();
            }),
        ),
        (
            "record owned by another process",
            Box::new(|repo: &Path| {
                plant_holder(repo, |r| {
                    r.prepare = Some(common::identity(5555, EARLIER_BIRTH));
                });
            }),
        ),
        (
            "unproven build process",
            Box::new(|repo: &Path| {
                plant_holder(repo, |r| r.resources.begin_build().unwrap());
            }),
        ),
    ];
    for (case, plant) in cases {
        let (repo, app) = app_repo();
        plant(&repo);
        let lock_dir = repo
            .join(".locks")
            .join(qaren::lease::lock_name(Platform::Ios, UDID));
        let mut mock = MockRunner::new();
        script_preflight_until_lease(&mut mock, &repo);
        mock.expect_run("ps", CmdOutput::success(""));
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{case}");
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.code, FailureCode::DeviceBusy, "{case}");
        assert!(
            failure.detail.contains("check-earlier"),
            "{case}: {}",
            failure.detail
        );
        assert!(
            failure.next_action.contains("qaren cleanup check-earlier"),
            "{case}: {}",
            failure.next_action
        );
        assert_eq!(receipt.run_id, "none", "{case}");
        assert_eq!(mock.remaining(), 0, "{case}");
        assert_eq!(
            qaren::buildplan::read_holder(&lock_dir).unwrap().run_id,
            "check-earlier",
            "{case}"
        );
        if case == "record owned by another process" {
            let earlier = RunRecord::load(&req.runs_root, "check-earlier").unwrap();
            assert_eq!(earlier.phase, Phase::Walking, "{case}: nothing was cleaned");
        }
    }
}

#[test]
fn a_dead_native_suite_holder_names_the_suite_recovery_command() {
    let (repo, app) = app_repo();
    let held = qaren::lease::acquire(
        &mut qaren::exec::MockRunner::new(),
        &repo.join(".locks"),
        Platform::Ios,
        UDID,
        "native-ios-1790000000000-4242",
        Some(common::identity(4242, EARLIER_BIRTH)),
    )
    .unwrap();
    let mut mock = MockRunner::new();
    script_preflight_until_lease(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success(""));
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;

    let failure = run(&mut mock, &req).failure.unwrap();

    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(
        failure.next_action.contains(
            "--example native-ios-suite -- recover --run-id native-ios-1790000000000-4242"
        ),
        "{}",
        failure.next_action
    );
    assert!(held.lock_dir.exists());
}

#[test]
fn a_holder_with_unknown_liveness_is_never_cleaned_up() {
    let (repo, app) = app_repo();
    plant_holder(&repo, |_| {});
    let mut mock = MockRunner::new();
    script_preflight_until_lease(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::failed(1, "ps: operation not permitted"));
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;

    let receipt = run(&mut mock, &req);

    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.next_action.contains("qaren cleanup check-earlier"));
    assert_eq!(mock.remaining(), 0);
    let earlier = RunRecord::load(&req.runs_root, "check-earlier").unwrap();
    assert_eq!(earlier.phase, Phase::Walking);
    assert!(!req.runs_root.join(run_id()).exists());
}

#[test]
fn every_plan_problem_names_the_file_line_and_repair_before_device_access() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../qaren-core/test/fixtures/plan-errors.json"
    ))
    .unwrap();
    for entry in cases.as_array().unwrap() {
        for (pr, phase) in [false, true]
            .into_iter()
            .flat_map(|pr| ["input-inventory", "plan-preflight"].map(|phase| (pr, phase)))
        {
            let (repo, app) = app_repo();
            let req = if pr {
                pr_request(&repo, &app)
            } else {
                request(&repo, &app, 30)
            };
            std::fs::write(&req.plan_file, entry["plan"].as_str().unwrap()).unwrap();
            let mut mock = MockRunner::new();
            mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
            if pr {
                mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
                mock.expect_run("gh pr view", pr_view_json(PR_HEAD));
                mock.expect_run("fetch origin pull/12/head", CmdOutput::success(""));
                mock.expect_run(
                    "rev-parse refs/qaren/pr/",
                    CmdOutput::success(&format!("{PR_HEAD}\n")),
                );
                mock.expect_run("update-ref -d", CmdOutput::success(""));
            }
            if phase == "plan-preflight" {
                script_inventory(&mut mock);
            }
            mock.expect_run("walk.js --preflight-stdin", CmdOutput {
                exit_code: Some(4),
                stdout: serde_json::json!({"ok":false,"code":"PLAN_UNPARSEABLE","refused":[{
                    "line":entry["line"],"reason":entry["reason"],"nextAction":entry["nextAction"]
                }]}).to_string(),
                ..Default::default()
            });
            let receipt = run(&mut mock, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused, "{entry} {phase}");
            let failure = receipt.failure.unwrap();
            assert_eq!(
                failure.code,
                FailureCode::PlanUnparseable,
                "{entry} {phase}"
            );
            assert!(
                failure.detail.contains(&format!(
                    "{}: line {}: {}",
                    req.plan_file.display(),
                    entry["line"],
                    entry["reason"].as_str().unwrap()
                )),
                "{}",
                failure.detail
            );
            assert!(
                failure
                    .next_action
                    .contains(entry["nextAction"].as_str().unwrap()),
                "{}",
                failure.next_action
            );
            assert!(failure
                .next_action
                .contains(&req.plan_file.display().to_string()));
            assert!(failure.next_action.ends_with("; then re-run"));
            assert!(!failure.next_action.contains("qaren check"));
            assert_eq!(mock.remaining(), 0);
            assert!(mock.calls.iter().all(|c| {
                Path::new(&c.program) == req.node.as_deref().unwrap()
                    || (pr && ["git", "gh"].contains(&c.program.as_str()))
            }));
        }
    }
}

#[test]
fn a_plan_refusal_without_a_repair_is_a_malformed_core_reply() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.environment
        .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_inventory(&mut mock);
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput {
            exit_code: Some(4),
            stdout: r#"{"ok":false,"code":"PLAN_UNPARSEABLE","refused":[{"line":3,"text":"Frobnicate","reason":"no verb"}]}"#.to_string(),
            ..Default::default()
        },
    );
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CoreRefused
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn an_old_node_refuses_at_preflight() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v22.11.0\n"));
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::NodeUnsupported
    );
}

#[test]
fn a_child_refusal_is_a_typed_refusal_with_the_child_code() {
    for admitted in [false, true] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        let refusal = r#"{"verdict":"REFUSED","code":"TARGET_AMBIGUOUS","message":"scriptURL port 8081 != 8791"}"#;
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        let stdout = if admitted {
            format!(
                "{}\n{}\n",
                envelope(2, "admitted", "{}"),
                envelope(3, "result", refusal)
            )
        } else {
            format!("{}\n", envelope(2, "result", refusal))
        };
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(4));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        mock.environment.insert("CLAUDECODE".into(), "1".into());
        mock.environment.insert(
            "CLAUDE_CODE_SESSION_ID".into(),
            "/private/session key".into(),
        );
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        let (receipt, events) = run_with_events(&mut mock, &req);
        let identity = &events.iter().find(|e| e["event"] == "run").unwrap()["payload"];
        assert_eq!(identity["harness"], "claude");
        assert_eq!(identity["markers"], serde_json::json!(["claude"]));
        assert_eq!(identity["flags"], serde_json::json!(["device"]));
        assert!(identity.get("harnessSession").is_none());
        assert!(!identity.to_string().contains(UDID));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        let failed_steps: Vec<_> = events
            .iter()
            .filter(|e| {
                e["event"] == "stage"
                    && e["payload"]["name"] == "steps"
                    && e["payload"]["state"] == "failed"
            })
            .collect();
        assert_eq!(failed_steps.len(), 1, "admitted={admitted}: {events:?}");
        assert_eq!(failed_steps[0]["payload"]["code"], "TARGET_AMBIGUOUS");
        assert_eq!(failed_steps[0]["payload"]["ms"].is_u64(), admitted);
        let cleanup = events
            .iter()
            .find(|e| e["event"] == "stage" && e["payload"]["name"] == "cleanup")
            .unwrap();
        assert!(failed_steps[0]["seq"].as_u64().unwrap() < cleanup["seq"].as_u64().unwrap());
        assert_direct_ios_launch(&mock);
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::CoreRefused);
        assert!(failure.detail.contains("8081"));
        assert_eq!(mock.remaining(), 0);
        assert_eq!(receipt.cleanup["device_lease"], "removed");
    }
}

#[test]
fn every_core_refusal_code_ends_through_teardown() {
    for (code, expected) in [
        ("METRO_ORIGIN_MISMATCH", FailureCode::MetroOriginMismatch),
        ("PLAN_INPUT_MISSING", FailureCode::PlanInputMissing),
        ("PLAN_UNPARSEABLE", FailureCode::PlanUnparseable),
        ("BLOCK_START_MISSING", FailureCode::BlockStartMissing),
        ("LANE_NOT_WARM", FailureCode::LaneNotWarm),
        ("JEV_AUTH_FAILED", FailureCode::JevAuthFailed),
        ("JEV_REQUEST_INVALID", FailureCode::JevRequestInvalid),
        ("JEV_UNREACHABLE", FailureCode::JevUnreachable),
        ("RUN_CANCELLED", FailureCode::RunCancelled),
        ("OTHER", FailureCode::CoreRefused),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        let refusal = serde_json::json!({
            "verdict": "REFUSED", "code": code, "message": "walk refused"
        });
        let stdout = format!(
            "{}\n{}\n",
            envelope(2, "admitted", "{}"),
            envelope(3, "result", &refusal.to_string())
        );
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(4));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let (receipt, events) = run_with_events(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.result, ReceiptResult::Refused, "{code}");
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, expected, "{code}");
        assert_eq!(failure.detail, format!("{code}: walk refused"), "{code}");
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{code}");
        let cleanup = events
            .iter()
            .position(|event| {
                event["event"] == "stage"
                    && event["payload"]["name"] == "cleanup"
                    && event["payload"]["state"] == "passed"
            })
            .unwrap_or_else(|| panic!("{code}: no completed cleanup stage"));
        let end = events
            .iter()
            .position(|event| event["event"] == "end")
            .unwrap();
        assert!(cleanup < end, "{code}");
        assert_eq!(mock.remaining(), 0, "{code}");
    }
}

#[test]
fn an_unresolved_metro_group_retains_the_device_lease_for_cleanup() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_admission(&mut mock);
    script_app_presence(&mut mock, false);
    script_provision_after_deps(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    // Drift report, then the Metro group: alive, TERM, KILL, and the leader survives both.
    script_drift_status(&mut mock);
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // leader survived
    mock.expect_run("ps", CmdOutput::success("S\n"));
    script_host_probe(&mut mock, UDID, hosts_absent());

    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut mock, &req);

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        receipt.cleanup["metro"].starts_with("unresolved"),
        "{}",
        receipt.cleanup["metro"]
    );
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: metro"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    assert_eq!(
        receipt.next_action,
        format!("qaren cleanup {} --json", run_id())
    );
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Walking);
    assert!(
        record.resources.lease.is_some(),
        "the lease stays with the run until Metro is proven gone"
    );
    assert!(record.resources.metro.is_some());
    assert!(repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());
}

#[test]
fn an_unreadable_disk_budget_fails_closed_before_any_claim() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", CmdOutput::failed(1, "df: No such file or directory"));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_ne!(receipt.result, ReceiptResult::Pass);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::PrereqMissing);
    assert_eq!(failure.phase, "preflight");
    assert!(
        failure.detail.contains("df could not report"),
        "{}",
        failure.detail
    );
    assert_eq!(receipt.run_id, "none");
    assert_eq!(mock.remaining(), 0);
    assert!(!repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());
}

#[test]
fn a_core_group_survivor_retains_the_device_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped_holding(
        "walk.js",
        9000,
        &pass_stdout(),
        Some(0),
        HoldStdout::Forever,
    );
    script_core_identity(&mut mock);
    script_drift_status(&mut mock);
    script_teardown_after_drift(
        &mut mock,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        UDID,
        None,
    );

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        receipt.cleanup["core"].starts_with("unresolved"),
        "{}",
        receipt.cleanup["core"]
    );
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert!(receipt.cleanup["runner_host"].starts_with("refused: core quiescence"));
    assert!(!mock
        .calls
        .iter()
        .any(|spec| spec.rendered().contains("simctl terminate")));
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert!(record.resources.lease.is_some());
    assert_eq!(record.phase, Phase::Walking);
}

const OTHER_UDID: &str = "76709EFC-0104-4A66-8908-F4F85A76F025";

fn booted_json_two() -> String {
    format!(
        r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"udid":"{UDID}","name":"qa-company-app","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}},{{"udid":"{OTHER_UDID}","name":"other","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}}]}}}}"#
    )
}

fn script_preflight_booted(mock: &mut MockRunner, repo: &Path, booted: &str) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(mock, repo);
    mock.expect_run("simctl list devices booted", CmdOutput::success(booted));
}

#[test]
fn two_booted_simulators_refuse_without_a_device_and_borrow_the_named_one_with_it() {
    let (repo, app) = app_repo();
    let mut refusing = MockRunner::new();
    script_preflight_booted(&mut refusing, &repo, &booted_json_two());
    let receipt = run(&mut refusing, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .detail
        .contains("2 booted"));
    assert_eq!(refusing.remaining(), 0);

    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &booted_json_two());
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren check\n"));
    mock.expect_run("lsof", free_port());
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, OTHER_UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown_core_host(
        &mut mock,
        CmdOutput::success("1 1 S\n6000 6000 S\n"),
        false,
        OTHER_UDID,
        Some(hosts_absent()),
    );

    let mut req = request(&repo, &app, 30);
    req.device = Some(OTHER_UDID.to_string());
    let receipt = run(&mut mock, &req);
    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().udid,
        OTHER_UDID
    );
    assert!(
        repo.join(".locks")
            .join(qaren::lease::lock_name(Platform::Ios, UDID))
            .exists()
            == false
    );
}

#[test]
fn a_named_device_that_is_not_booted_refuses() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &booted_json());
    let mut req = request(&repo, &app, 30);
    req.device = Some(OTHER_UDID.to_string());
    let receipt = run(&mut mock, &req);
    assert_ne!(receipt.result, ReceiptResult::Pass);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(failure.detail.contains(OTHER_UDID), "{}", failure.detail);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn boot_device_requires_ios_and_an_exact_uuid_before_any_preflight() {
    for (boot, restart, shutdown_on_exit) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        for (platform, device, expected) in [
            (
                Platform::Android,
                Some(UDID),
                FailureCode::PlatformUnsupported,
            ),
            (Platform::Ios, None, FailureCode::DeviceUnavailable),
            (
                Platform::Ios,
                Some("booted"),
                FailureCode::DeviceUnavailable,
            ),
            (
                Platform::Ios,
                Some("qa-company-app"),
                FailureCode::DeviceUnavailable,
            ),
            (
                Platform::Ios,
                Some("1DC408C4-51DA-4C4F-ACA1-39881C916FDG"),
                FailureCode::DeviceUnavailable,
            ),
        ] {
            let (repo, app) = app_repo();
            let mut req = request(&repo, &app, 30);
            req.platform = platform;
            req.device = device.map(str::to_string);
            req.boot_device = boot;
            req.restart_device = restart;
            req.shutdown_device_on_exit = shutdown_on_exit;
            let mut mock = MockRunner::new();
            let receipt = run(&mut mock, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert_eq!(receipt.failure.unwrap().code, expected);
            assert!(mock.calls.is_empty());
            assert!(!req.lock_root.exists());
            assert!(!req.runs_root.exists());
        }
    }
    let (repo, app) = app_repo();
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.to_string());
    req.boot_device = true;
    req.restart_device = true;
    let mut mock = MockRunner::new();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert!(mock.calls.is_empty());
    assert!(!req.lock_root.exists());
    assert!(!req.runs_root.exists());
}

const ADB_CLIENT_41: &str = "Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\nInstalled as /sdk/platform-tools/adb\n";
const EMULATOR: &str = "emulator-5554";
const ANDROID_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "java"];
const ONE_EMULATOR: &str = "List of devices attached\nemulator-5554\tdevice\n\n";

// A real platform-tools/adb file: the borrow and the prereq check both require it on disk.
fn android_request(repo: &Path, app: &Path) -> RunRequest {
    let home = repo.join("sdk");
    std::fs::create_dir_all(home.join("platform-tools")).unwrap();
    std::fs::write(home.join("platform-tools/adb"), "").unwrap();
    let mut req = request(repo, app, 30);
    req.platform = Platform::Android;
    req.android_home = Some(home.to_string_lossy().into_owned());
    req
}

fn android_mock() -> MockRunner {
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5037, 41));
    mock
}

fn script_borrow(mock: &mut MockRunner, devices: &str, serial: &str) {
    script_borrow_api(mock, devices, serial, 37);
}

fn script_borrow_api(mock: &mut MockRunner, devices: &str, serial: &str, api: u16) {
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("adb devices", CmdOutput::success(devices));
    mock.expect_run(
        &format!("-s {serial} shell getprop sys.boot_completed"),
        CmdOutput::success("1\n"),
    );
    mock.expect_run(
        "getprop ro.build.version.sdk",
        CmdOutput::success(&format!("{api}\n")),
    );
    mock.expect_run("getprop ro.product.cpu.abi", CmdOutput::success("x86_64\n"));
    mock.expect_run(
        &format!("-s {serial} emu avd name"),
        CmdOutput::success("Pixel_9_API_37\r\nOK\r\n"),
    );
}

// Node, plan preflight, the borrow, candidate, prereqs, disk and self identity, then the Metro port after the lease.
fn script_android_preflight(mock: &mut MockRunner, repo: &Path, devices: &str, serial: &str) {
    script_android_preflight_requiring(mock, repo, devices, serial, &[], &[]);
}

fn script_android_preflight_requiring(
    mock: &mut MockRunner,
    repo: &Path,
    devices: &str,
    serial: &str,
    required: &[&str],
    non_secret: &[&str],
) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan_requiring(mock, repo, required, non_secret);
    script_borrow(mock, devices, serial);
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    for tool in ANDROID_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren check\n"));
    mock.expect_run("lsof", free_port());
}

fn adb_calls(mock: &MockRunner) -> Vec<String> {
    mock.calls
        .iter()
        .filter(|c| c.program.ends_with("/adb"))
        .map(|c| c.args.join(" "))
        .collect()
}

fn no_ios_or_expo_android_build(mock: &MockRunner) {
    for call in &mock.calls {
        let rendered = call.rendered();
        assert!(
            !rendered.contains("xcrun") && !rendered.contains("run:android"),
            "{rendered}"
        );
    }
}

// Install by serial → reverse → Metro → deeplink → readiness → verify → walk → teardown.
fn script_android_launch_walk_teardown(mock: &mut MockRunner) {
    script_android_launch_walk_release(mock, false);
}

fn script_android_launch_walk_release(mock: &mut MockRunner, runner_running: bool) {
    script_android_launch(mock, 0);
    script_android_app_tick(mock, CmdOutput::success("4242\n"));
    script_android_walk_release(mock, runner_running);
}

// Install, reverse, Metro and the deeplink, then `no_pid_ticks` readiness ticks without the app process.
fn script_android_launch(mock: &mut MockRunner, no_pid_ticks: usize) {
    mock.expect_run(
        "install -r -d",
        CmdOutput::success("Performing Streamed Install\nSuccess\n"),
    );
    mock.expect_run(
        "reverse --no-rebind tcp:8791 tcp:8791",
        CmdOutput::success("8791\n"),
    );
    mock.expect_spawn(
        "expo start",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("node expo start"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("am start", CmdOutput::success("Starting: Intent"));
    for _ in 0..no_pid_ticks {
        script_android_app_tick(mock, CmdOutput::failed(1, ""));
    }
}

fn script_android_app_tick(mock: &mut MockRunner, pidof: CmdOutput) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "pm path com.rndevagent.testapp",
        CmdOutput::success("package:/data/app/~~x/com.rndevagent.testapp/base.apk\n"),
    );
    mock.expect_run("pidof com.rndevagent.testapp", pidof);
}

fn script_android_walk_release(mock: &mut MockRunner, runner_running: bool) {
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_drift_status(mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(mock);
    script_drift_status(mock);
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    script_metro_teardown(mock, EMULATOR, None);
    script_borrowed_release(mock, runner_running);
}

// `dumpsys activity processes <runner>` on an API 37 emulator, runner instrumenting and stopped.
const RUNNER_PROCESSES: &str = include_str!("fixtures/android-runner-processes-running.txt");
const NO_RUNNER_PROCESS: &str = include_str!("fixtures/android-runner-processes-stopped.txt");

// Teardown's borrowed-emulator release: the Metro reverse, then the core's runner.
fn script_borrowed_release(mock: &mut MockRunner, runner_running: bool) {
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run("reverse --list", CmdOutput::success(""));
    if runner_running {
        // Real adb bytes: a trailing blank line when non-empty, a lone newline when empty.
        mock.expect_run(
            "forward --list",
            CmdOutput::success(&format!("{EMULATOR} tcp:41234 tcp:22089\n\n")),
        );
        mock.expect_run(
            "dumpsys activity processes",
            CmdOutput::success(RUNNER_PROCESSES),
        );
        mock.expect_run("forward --remove tcp:41234", CmdOutput::success(""));
        mock.expect_run("am force-stop", CmdOutput::success(""));
        mock.expect_run("am force-stop", CmdOutput::success(""));
    }
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );
}

// One finite build: the gated spawn, its group identity, then its group proven gone.
fn script_android_finite_build(mock: &mut MockRunner, command: &str, pid: i32, exit: i32) {
    mock.expect_spawn_piped(command, pid, "", Some(exit));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:00:00 2026"));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
}

const PREBUILD: &str = "expo prebuild --platform android --clean";
const GRADLE: &str =
    "./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --no-daemon --console=plain";

#[test]
fn android_check_does_not_cache_an_apk_replaced_after_install() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.apk_replacement_after_install = Some(b"replacement apk".to_vec());
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    assert!(mock.apk_replacement_after_install.is_none());
    let record = RunRecord::load(&req.runs_root, &receipt.run_id).unwrap();
    let installed = record.resources.app_install.unwrap().artifact;
    assert_eq!(installed.sha256, qaren::candidate::sha256_hex(b"built apk"));
    assert_eq!(std::fs::read(&installed.path).unwrap(), b"replacement apk");
    assert!(receipt.outcomes["artifact_cache"].contains("differs from the verified build"));
    assert!(!qaren::buildplan::state_path(&repo, "android", "com.rndevagent.testapp").exists());
    let artifacts = qaren::buildplan::cache_dir(&repo).join("artifacts/android");
    for bucket in std::fs::read_dir(artifacts).unwrap() {
        assert_eq!(
            std::fs::read_dir(bucket.unwrap().path()).unwrap().count(),
            0
        );
    }
}

#[test]
fn android_check_prebuilds_an_absent_android_dir_before_gradle() {
    let (repo, app) = app_repo();
    let mut req = android_request(&repo, &app);
    let config = std::fs::read_to_string(&req.config_path).unwrap();
    std::fs::write(
        &req.config_path,
        format!("{config}registryAuthEnv: [CANDIDATE_REGISTRY_TOKEN]\n"),
    )
    .unwrap();
    req.config_path = repo.join("operator-config.yaml");
    std::fs::write(
        &req.config_path,
        format!("{config}registryAuthEnv: [PRIVATE_REGISTRY_TOKEN]\n"),
    )
    .unwrap();
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);

    let (receipt, events) = run_with_events(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    common::assert_registry_specs(&mock.calls);
    let prebuild = mock
        .calls
        .iter()
        .find(|spec| spec.label == "expo-prebuild")
        .unwrap();
    assert_eq!(prebuild.program, "/bin/bash");
    assert!(prebuild.unset.contains(&"CI".into()));
    assert_eq!(mock.piped_stdin_text(0), "start\n");
    let record = RunRecord::load(&req.runs_root, &receipt.run_id).unwrap();
    assert_eq!(
        record.scenario.deps.registry_auth_env,
        ["PRIVATE_REGISTRY_TOKEN"]
    );
    assert_subsequence(
        &labels(&mock),
        &[
            "expo-prebuild",
            "gradle-assemble",
            "adb-install",
            "adb-reverse",
            "adb-am-start",
        ],
    );
    let gradle = mock
        .calls
        .iter()
        .find(|c| c.label == "gradle-assemble")
        .unwrap();
    assert_eq!(
        gradle.cwd.as_deref(),
        Some(app.canonicalize().unwrap().join("android").as_path())
    );
    assert!(gradle.env.contains(&("CI".to_string(), "1".to_string())));
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.rendered().contains("run:android")));
    let trail = stage_trail(&events);
    let at = |stage: &str| {
        trail
            .iter()
            .position(|s| s == stage)
            .unwrap_or_else(|| panic!("{stage} not in {trail:?}"))
    };
    assert!(at("native_build passed") < at("install_launch_ready running"));
    assert!(at("install_launch_ready running") < at("install_launch_ready passed"));
    assert!(
        !trail
            .iter()
            .any(|s| s.starts_with("install_launch_ready skipped")),
        "{trail:?}"
    );
}

#[test]
fn only_ios_runs_with_runtime_inputs_disclose_the_simulator_log() {
    for non_secret in [false, true] {
        let (repo, app) = app_repo();
        let annotation = if non_secret { " (non-secret)" } else { "" };
        std::fs::write(
            app.join("plan.md"),
            format!("1. Fill \"password\" with input PASSWORD{annotation}\n"),
        )
        .unwrap();
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        script_android_preflight_requiring(
            &mut mock,
            &repo,
            ONE_EMULATOR,
            EMULATOR,
            &["PASSWORD"],
            if non_secret { &["PASSWORD"] } else { &[] },
        );
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(""));
        mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
        script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
        script_android_finite_build(&mut mock, GRADLE, 5001, 0);
        script_android_launch_walk_teardown(&mut mock);
        let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries([(
            "QAREN_INPUT_PASSWORD".into(),
            "android-synthetic".into(),
        )]));
        let receipt =
            qaren::redact::with_input_scope(inputs, || run_with_events(&mut mock, &req)).0;
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert!(!receipt.outcomes.contains_key("platform_log"));
    }
}

#[test]
fn android_check_refuses_to_generate_an_android_dir_git_would_track() {
    for (case, ignore, detail) in [
        (
            "tracked",
            CmdOutput::failed(1, ""),
            "android/ is absent and not git-ignored",
        ),
        (
            "git_failed",
            CmdOutput::failed(128, "fatal"),
            "cannot tell whether git ignores android/",
        ),
    ] {
        let (repo, app) = app_repo();
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(""));
        mock.expect_run("check-ignore -q android/", ignore);

        let receipt = run(&mut mock, &req);

        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::BuildFailed, "{case}");
        assert!(
            failure.detail.contains(detail),
            "{case}: {}",
            failure.detail
        );
        assert_eq!(mock.remaining(), 0, "{case}");
        assert!(
            !labels(&mock)
                .iter()
                .any(|l| l == "expo-prebuild" || l == "gradle-assemble" || l == "adb-install"),
            "{case}"
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{case}");
    }
}

#[test]
fn android_check_prebuild_failure_is_build_failed() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    common::append_registry_config(&req.config_path);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 1);

    let receipt = run(&mut mock, &req);

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .next_action
        .contains("output was withheld"));
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .next_action
        .contains("registry setup"));
    assert_eq!(mock.piped_stdin_text(0), "start\n");
    assert!(!labels(&mock).iter().any(|l| l == "gradle-assemble"));
    let devices: Vec<String> = adb_calls(&mock)
        .into_iter()
        .filter(|c| {
            !c.contains("getprop")
                && !c.contains("emu avd name")
                && c != "devices"
                && c != "version"
        })
        .collect();
    assert!(devices.is_empty(), "{devices:?}");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
}

#[test]
fn android_check_present_android_dir_skips_prebuild() {
    use qaren::buildplan::{save_json, state_path, NativeCacheState, CACHE_SCHEMA};
    let (repo, app) = app_repo();
    std::fs::create_dir_all(app.join("android")).unwrap();
    std::fs::write(app.join("android/gradlew"), "#!/bin/sh\n").unwrap();
    let mut fp_runner = qaren::exec::MockRunner::new();
    fp_runner.expect_run("ls-files", CmdOutput::success(""));
    let fp = qaren::fingerprint::compute(&mut fp_runner, &repo, &app, "android").unwrap();
    save_json(
        &state_path(&repo, "android", "com.rndevagent.testapp"),
        &NativeCacheState {
            schema: CACHE_SCHEMA.to_string(),
            fingerprint_parts: fp.parts.clone(),
            platform: "android".to_string(),
            app_id: "com.rndevagent.testapp".to_string(),
            worktree_root: repo.canonicalize().unwrap(),
            fingerprint: fp.value,
            built_at: "2026-10-11T00:00:00Z".to_string(),
            candidate_sha: "b".repeat(40),
            lockfile_sha256: String::new(),
            generated_native_dirs: vec!["android".to_string()],
            artifact: None,
        },
    )
    .unwrap();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(
        receipt.build.as_ref().unwrap().decision,
        qaren::buildplan::BuildDecision::Incremental
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "expo-prebuild"));
}

#[test]
fn android_check_records_generated_android_dir_then_reuses() {
    let (repo, app) = app_repo();
    let mut req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);
    let first = run(&mut mock, &req);
    assert_eq!(first.result, ReceiptResult::Pass, "{:?}", first.failure);
    assert_eq!(mock.remaining(), 0);
    let state = qaren::buildplan::state_path(&repo, "android", "com.rndevagent.testapp");
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(state).unwrap()).unwrap();
    assert_eq!(
        state["generated_native_dirs"],
        serde_json::json!(["android"])
    );

    req.runs_root = repo.join("runs-2");
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_launch_walk_teardown(&mut mock);
    let second = run(&mut mock, &req);
    assert_eq!(second.result, ReceiptResult::Pass, "{:?}", second.failure);
    assert_eq!(
        second.build.as_ref().unwrap().decision,
        qaren::buildplan::BuildDecision::Reuse
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock)
        .iter()
        .any(|l| l == "expo-prebuild" || l == "gradle-assemble"));
    let cached = second.build.unwrap().artifact.unwrap().path;
    assert!(
        cached.ends_with(format!(
            ".qaren/native-cache/artifacts/android/{}/{}/app-debug.apk",
            cached
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            run_id()
        )),
        "{}",
        cached.display()
    );
    assert!(!req.native_cache_root.exists());
}

#[test]
fn android_never_reads_or_writes_the_machine_store() {
    use qaren::buildplan::{store_dir, ArtifactKind, BuildDecision, STORE_RECORD};
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut fp_runner = qaren::exec::MockRunner::new();
    fp_runner.expect_run("ls-files", CmdOutput::success(""));
    let fp = qaren::fingerprint::compute(&mut fp_runner, &repo, &app, "android").unwrap();
    let apk = repo.join("elsewhere/app-debug.apk");
    std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
    std::fs::write(&apk, b"another clone's apk").unwrap();
    let entry = store_dir(
        &req.native_cache_root,
        "android",
        "com.rndevagent.testapp",
        &fp.value,
    );
    std::fs::create_dir_all(&entry).unwrap();
    std::fs::create_dir(entry.join("seed-run")).unwrap();
    std::fs::copy(&apk, entry.join("seed-run/app-debug.apk")).unwrap();
    std::fs::write(
        entry.join(STORE_RECORD),
        serde_json::to_vec(&qaren::buildplan::StoreRecord {
            artifact: qaren::buildplan::CachedArtifact {
                path: apk.clone(),
                sha256: qaren::buildplan::hash_artifact(&apk).unwrap(),
                kind: ArtifactKind::Apk,
            },
            built_at: "fixture".into(),
            candidate_sha: "a".repeat(40),
        })
        .unwrap(),
    )
    .unwrap();
    let record = std::fs::read(entry.join(STORE_RECORD)).unwrap();
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    let plan = receipt.build.unwrap();
    assert_eq!(plan.decision, BuildDecision::Clean, "{}", plan.reason);
    assert!(!plan.evidence.iter().any(|e| e.contains("machine store")));
    assert_eq!(std::fs::read(entry.join(STORE_RECORD)).unwrap(), record);
    let entries: Vec<_> = std::fs::read_dir(&entry)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert!(entries.contains(&"seed-run".to_string()), "{entries:?}");
}

#[test]
fn android_check_does_not_require_the_shared_configs_ios_workspace() {
    let (repo, app) = app_repo();
    configure_workspace(&app, "ios/Missing.xcworkspace", "Native");
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    no_ios_or_expo_android_build(&mock);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    let emulator = record.resources.android_emulator.as_ref().unwrap();
    assert_eq!(
        (
            emulator.serial.as_str(),
            emulator.avd.as_str(),
            emulator.server_port
        ),
        (EMULATOR, "Pixel_9_API_37", 5037)
    );
    assert_eq!((emulator.api_level, emulator.abi.as_str()), (37, "x86_64"));
    assert!(record.resources.adb_server.is_none());
    assert_eq!(
        record.scenario.android_emulator.as_ref().unwrap().serial,
        EMULATOR
    );
    assert!(record.scenario.build.ios_workspace.is_none());
}

// A native cache entry whose APK matches the worktree, so the run decides Reuse.
fn seed_cached_apk(repo: &Path, app: &Path) -> std::path::PathBuf {
    use qaren::buildplan::{
        hash_artifact, save_json, state_path, ArtifactKind, CachedArtifact, NativeCacheState,
        CACHE_SCHEMA,
    };
    let apk = repo.join("cached").join("app-debug.apk");
    std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
    std::fs::write(&apk, b"cached apk").unwrap();
    let mut fp_runner = qaren::exec::MockRunner::new();
    fp_runner.expect_run("ls-files", CmdOutput::success(""));
    let fp = qaren::fingerprint::compute(&mut fp_runner, repo, app, "android").unwrap();
    save_json(
        &state_path(repo, "android", "com.rndevagent.testapp"),
        &NativeCacheState {
            schema: CACHE_SCHEMA.to_string(),
            fingerprint_parts: fp.parts.clone(),
            platform: "android".to_string(),
            app_id: "com.rndevagent.testapp".to_string(),
            worktree_root: repo.canonicalize().unwrap(),
            fingerprint: fp.value,
            built_at: "2026-10-11T00:00:00Z".to_string(),
            candidate_sha: "b".repeat(40),
            lockfile_sha256: String::new(),
            generated_native_dirs: Vec::new(),
            artifact: Some(CachedArtifact {
                path: apk.clone(),
                sha256: hash_artifact(&apk).unwrap(),
                kind: ArtifactKind::Apk,
            }),
        },
    )
    .unwrap();
    apk
}

#[test]
fn android_check_reuse_installs_the_cached_apk_by_serial() {
    let (repo, app) = app_repo();
    let apk = seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "{:?} {:?}",
        receipt.failure,
        receipt.build
    );
    assert_eq!(mock.remaining(), 0);
    no_ios_or_expo_android_build(&mock);
    assert!(!labels(&mock)
        .iter()
        .any(|l| l == "expo-prebuild" || l == "gradle-assemble"));
    let adb = adb_calls(&mock);
    let position = |needle: &str| {
        adb.iter()
            .position(|c| c.contains(needle))
            .unwrap_or_else(|| panic!("{needle} not in {adb:?}"))
    };
    assert_eq!(
        adb[position("install")],
        format!("-s {EMULATOR} install -r -d {}", apk.display())
    );
    assert!(
        position("install") < position("reverse") && position("reverse") < position("am start")
    );
    for call in mock
        .calls
        .iter()
        .filter(|c| c.program.ends_with("/adb") && c.label != "adb-version")
    {
        assert!(
            call.env.contains(&(
                "ADB_SERVER_SOCKET".to_string(),
                "tcp:127.0.0.1:5037".to_string()
            )),
            "{}",
            call.rendered()
        );
    }
    let walk = mock.calls.iter().find(|c| c.label == "core-walk").unwrap();
    assert!(walk
        .env
        .contains(&("ANDROID_SERIAL".to_string(), EMULATOR.to_string())));
    assert!(!mock.piped_stdin_text(0).contains("\"adb\""));
    let request: serde_json::Value = serde_json::from_str(mock.piped_stdin_text(0).trim()).unwrap();
    assert!(request["payload"]["target"]
        .get("metroBundleRequests")
        .is_none());
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.resources.adb_reverse_port, Some(8791));
    let install = record.resources.app_install.as_ref().unwrap();
    assert_eq!(
        (install.serial.as_str(), install.via.as_str()),
        (EMULATOR, "adb-install")
    );
    assert!(record.resources.runner_host.is_none());
}

#[test]
fn android_check_borrows_the_named_emulator_among_two() {
    const TWO: &str = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n";
    let (repo, app) = app_repo();
    let mut req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("adb devices", CmdOutput::success(TWO));
    for serial in ["emulator-5554", "emulator-5556"] {
        mock.expect_run(
            &format!("-s {serial} shell getprop sys.boot_completed"),
            CmdOutput::success("1\n"),
        );
    }
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(
        failure.detail.starts_with("2 booted emulators"),
        "{}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.exists());

    req.device = Some("emulator-5556".into());
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, TWO, "emulator-5556");
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&req.runs_root, &receipt.run_id).unwrap();
    assert_eq!(
        record.resources.adb_local_serial.as_deref(),
        Some("emulator-5556")
    );
    assert!(adb_calls(&mock)
        .iter()
        .filter(|c| c.starts_with("-s "))
        .all(|c| c.starts_with("-s emulator-5556 ")));
}

#[test]
fn android_check_auto_selects_the_only_boot_completed_emulator() {
    const TWO: &str = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n";
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("adb devices", CmdOutput::success(TWO));
    mock.expect_run(
        "-s emulator-5554 shell getprop sys.boot_completed",
        CmdOutput::success("\n"),
    );
    mock.expect_run(
        "-s emulator-5556 shell getprop sys.boot_completed",
        CmdOutput::success("1\n"),
    );
    mock.expect_run("getprop ro.build.version.sdk", CmdOutput::success("37\n"));
    mock.expect_run("getprop ro.product.cpu.abi", CmdOutput::success("x86_64\n"));
    mock.expect_run(
        "-s emulator-5556 emu avd name",
        CmdOutput::success("Pixel_9_API_37\r\nOK\r\n"),
    );
    // Stop right after the borrow: the candidate read refuses, proving which emulator was taken.
    mock.expect_run("git", CmdOutput::failed(128, "not a git repository"));
    let receipt = run(&mut mock, &req);
    assert_ne!(
        receipt.failure.as_ref().map(|f| f.code),
        Some(FailureCode::DeviceUnavailable),
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(adb_calls(&mock)
        .iter()
        .filter(|c| c.starts_with("-s ") && !c.ends_with("sys.boot_completed"))
        .all(|c| c.starts_with("-s emulator-5556 ")));
}

#[test]
fn android_check_refuses_an_adb_client_newer_than_the_server() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run(
        "adb version",
        CmdOutput::success(&ADB_CLIENT_41.replace("1.0.41", "1.0.42")),
    );
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(
        failure
            .detail
            .contains("is version 42, the running server is 41"),
        "{}",
        failure.detail
    );
    assert_eq!(adb_calls(&mock), ["version"]);
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.exists());
}

#[test]
fn android_check_refuses_an_unreadable_adb_client_version() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run("adb version", CmdOutput::success("not adb\n"));
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::PrereqMissing);
    assert_eq!(adb_calls(&mock), ["version"]);
    assert!(!req.lock_root.exists());
}

#[test]
fn android_check_refuses_when_no_adb_server_listens() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(
        failure
            .detail
            .contains("no adb server is running on port 5037"),
        "{}",
        failure.detail
    );
    assert!(adb_calls(&mock).is_empty());
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.exists());
}

#[test]
fn android_check_refuses_unborrowable_devices_without_a_lease() {
    for (case, devices, boot_completed, detail) in [
        (
            "booting",
            ONE_EMULATOR,
            Some(""),
            "emulator-5554 has not finished booting",
        ),
        (
            "physical_only",
            "List of devices attached\n0A1B2C3D\tdevice\nemulator-5556\toffline\n",
            None,
            "no booted emulator; 1 other device(s) ignored: physical devices are not supported in this release",
        ),
    ] {
        let (repo, app) = app_repo();
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        script_plan(&mut mock, &repo);
        mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
        mock.expect_run("adb devices", CmdOutput::success(devices));
        if let Some(value) = boot_completed {
            mock.expect_run("getprop sys.boot_completed", CmdOutput::success(value));
        }
        let receipt = run(&mut mock, &req);
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.code, FailureCode::DeviceUnavailable, "{case}");
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert!(failure.detail.starts_with(detail), "{case}: {}", failure.detail);
        assert_eq!(mock.remaining(), 0, "{case}");
        assert!(!req.lock_root.exists(), "{case}");
    }
}

#[test]
fn android_check_refuses_a_remote_adb_socket() {
    let (repo, app) = app_repo();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    mock.environment
        .insert("ADB_SERVER_SOCKET".into(), "tcp:10.0.0.5:5037".into());
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(
        failure.detail.contains("not a loopback adb server"),
        "{}",
        failure.detail
    );
    assert!(adb_calls(&mock).is_empty());
    assert!(!req.lock_root.exists());
}

fn script_android_admission(mock: &mut MockRunner, status: &str) {
    mock.expect_run(
        &format!("fresh-install-preflight.js --platform android --device {EMULATOR}"),
        CmdOutput {
            exit_code: Some(if status == "clear" { 0 } else { 4 }),
            stdout: serde_json::json!({
                "v": 1, "platform": "android", "deviceId": EMULATOR, "status": status
            })
            .to_string(),
            ..Default::default()
        },
    );
}

const APP_PACKAGE_LISTED: &str = "package:com.rndevagent.testapp\n";

fn android_package_list(mock: &mut MockRunner, stdout: &str) {
    mock.expect_run(
        "shell pm list packages com.rndevagent.testapp",
        CmdOutput::success(stdout),
    );
}

#[test]
fn android_fresh_install_with_clear_admission_uninstalls_and_proves_absence() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let mut req = android_request(&repo, &app);
    req.fresh_install = true;
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    script_android_admission(&mut mock, "clear");
    android_package_list(&mut mock, APP_PACKAGE_LISTED);
    mock.expect_run(
        "uninstall com.rndevagent.testapp",
        CmdOutput::success("Success\n"),
    );
    android_package_list(&mut mock, "");
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
    assert_eq!(mock.remaining(), 0);
    let admission = mock
        .calls
        .iter()
        .find(|c| c.label == "fresh-install-admission")
        .unwrap();
    assert!(!admission.args.iter().any(|a| a == "--process-observer"));
    for (key, value) in [
        ("ANDROID_SERIAL", EMULATOR),
        ("ADB_SERVER_SOCKET", "tcp:127.0.0.1:5037"),
    ] {
        assert!(
            admission
                .env
                .contains(&(key.to_string(), value.to_string())),
            "{key}"
        );
    }
    let adb = adb_calls(&mock);
    let position = |needle: &str| adb.iter().position(|c| c.contains(needle)).unwrap();
    assert_eq!(
        adb[position("uninstall")],
        format!("-s {EMULATOR} uninstall com.rndevagent.testapp")
    );
    assert!(position("uninstall") < position("install -r -d"));
    let labels = labels(&mock);
    let at = |label: &str| labels.iter().position(|l| l == label).unwrap();
    assert!(at("fresh-install-admission") < at("adb-pm-list-packages"));
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    let evidence = record.resources.fresh_install.as_ref().unwrap();
    assert_eq!(
        (evidence.device_id.as_str(), evidence.app_id.as_str()),
        (EMULATOR, "com.rndevagent.testapp")
    );
}

#[test]
fn android_fresh_install_skips_uninstall_when_the_app_is_proven_absent() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let mut req = android_request(&repo, &app);
    req.fresh_install = true;
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    script_android_admission(&mut mock, "clear");
    android_package_list(&mut mock, "package:com.rndevagent.testapp.other\n");
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_launch_walk_teardown(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "adb-uninstall"));
}

#[test]
fn android_fresh_install_refuses_busy_or_unknown_admission_before_any_uninstall() {
    for (status, code) in [
        ("busy", FailureCode::DeviceBusy),
        ("unknown", FailureCode::FreshInstallAdmissionUnknown),
    ] {
        let (repo, app) = app_repo();
        let mut req = android_request(&repo, &app);
        req.fresh_install = true;
        let mut mock = android_mock();
        script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
        script_android_admission(&mut mock, status);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{status}");
        let failure = receipt.failure.unwrap();
        assert_eq!(
            (failure.phase.as_str(), failure.code),
            ("fresh_install", code)
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{status}");
        assert_eq!(mock.remaining(), 0, "{status}");
        assert!(
            !adb_calls(&mock)
                .iter()
                .any(|c| c.contains("pm list packages") || c.contains("uninstall")),
            "{status}"
        );
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.fresh_install.is_none(), "{status}");
        assert!(record.resources.lease.is_none(), "{status}");
    }
}

#[test]
fn android_fresh_install_failures_use_the_ios_reset_codes() {
    let failed_list = CmdOutput::failed(1, "error: device offline");
    let cases: [(&str, Vec<(&str, CmdOutput)>, FailureCode); 4] = [
        (
            "unreadable inventory",
            vec![("shell pm list packages", failed_list.clone())],
            FailureCode::AppPresenceUnknown,
        ),
        (
            "uninstall failed",
            vec![
                (
                    "shell pm list packages",
                    CmdOutput::success(APP_PACKAGE_LISTED),
                ),
                (
                    "uninstall com.rndevagent.testapp",
                    CmdOutput::success("Failure [DELETE_FAILED_INTERNAL_ERROR]\n"),
                ),
            ],
            FailureCode::AppResetFailed,
        ),
        (
            "still installed",
            vec![
                (
                    "shell pm list packages",
                    CmdOutput::success(APP_PACKAGE_LISTED),
                ),
                (
                    "uninstall com.rndevagent.testapp",
                    CmdOutput::success("Success\n"),
                ),
                (
                    "shell pm list packages",
                    CmdOutput::success(APP_PACKAGE_LISTED),
                ),
            ],
            FailureCode::AppResetFailed,
        ),
        (
            "absence unreadable",
            vec![
                (
                    "shell pm list packages",
                    CmdOutput::success(APP_PACKAGE_LISTED),
                ),
                (
                    "uninstall com.rndevagent.testapp",
                    CmdOutput::success("Success\n"),
                ),
                ("shell pm list packages", failed_list.clone()),
            ],
            FailureCode::AppPresenceUnknown,
        ),
    ];
    for (case, script, code) in cases {
        let (repo, app) = app_repo();
        let mut req = android_request(&repo, &app);
        req.fresh_install = true;
        let mut mock = android_mock();
        script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
        script_android_admission(&mut mock, "clear");
        for (hint, output) in script {
            mock.expect_run(hint, output);
        }

        let receipt = run(&mut mock, &req);

        let failure = receipt.failure.unwrap();
        assert_eq!(
            (failure.phase.as_str(), failure.code),
            ("fresh_install", code),
            "{case}"
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{case}");
        assert_eq!(mock.remaining(), 0, "{case}");
        assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"), "{case}");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.fresh_install.is_none(), "{case}");
    }
}

#[test]
fn android_check_requires_dev_client_scheme() {
    let (repo, app) = app_repo();
    std::fs::write(
        app.join(".qaren/config.yaml"),
        "appId: com.rndevagent.testapp\nmetroPort: 8791\n",
    )
    .unwrap();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
    assert!(!failure.detail.contains("iOS"), "{}", failure.detail);
    assert!(mock.calls.is_empty());
}

#[test]
fn missing_or_rejected_key_refuses_before_device_or_lease() {
    for supplied in [false, true] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        // The core decides whether the plan needs Jev; a missing or rejected key fails its probe.
        if supplied {
            mock.environment
                .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
        }
        script_inventory(&mut mock);
        mock.expect_run("walk.js --preflight-stdin", CmdOutput {
            exit_code: Some(4),
            stdout: serde_json::json!({"ok":false,"code":"JEV_UNREACHABLE","message":TEST_KEY,
                "jev":{"calls":1,"medianMs":5,"inputTokens":0,"callDetails":[{
                    "scope":"preflight","questionIds":["preflight"],"inputTokens":null,"ms":5,"outcome":"http","status":401
                }]}}).to_string(),
            ..Default::default()
        });
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::JevUnreachable
        );
        assert_eq!(receipt.run_id, "none");
        assert!(!repo.join(".locks").exists());
        assert!(!repo.join("runs").exists());
        assert_eq!(mock.remaining(), 0);
        assert!(!receipt.to_json().contains(TEST_KEY));
        assert!(!labels(&mock).iter().any(|l| l == "simctl-list-booted"));
    }
}

#[test]
fn walk_jev_refusals_preserve_prior_passes_and_the_complete_failure_evidence() {
    for (code, expected, status) in [
        ("JEV_AUTH_FAILED", FailureCode::JevAuthFailed, 401),
        ("JEV_REQUEST_INVALID", FailureCode::JevRequestInvalid, 422),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        let jev = serde_json::json!({"calls":2,"medianMs":25,"inputTokens":10,"callDetails":[
            probe_json()["callDetails"][0],
            {"scope":"walk","questionIds":["front"],"inputTokens":null,"ms":38,"outcome":"http","status":status}
        ]});
        let steps = serde_json::json!([
            {"block":"navigation","line":1,"attempt":1,"kind":"step","resolvedBy":"exact","t":10,"outcome":"pass","text":"Open tasks","screenshot":"screenshots/open-tasks.png"},
            {"block":"navigation","line":4,"attempt":1,"kind":"check","resolvedBy":"jev","t":20,"outcome":"pass","text":"Check home","screenshot":"screenshots/home.png"},
            {"block":"account","line":9,"attempt":1,"kind":"check","resolvedBy":"jev","t":30,"outcome":"fail","text":"Check account","reason":"judgment refused","screenshot":"screenshots/row-nine.png"}
        ]);
        let blocks = serde_json::json!([
            {"key":"navigation","outcome":"pass","source":"discovered"},
            {"key":"account","outcome":"fail","source":"discovered"}
        ]);
        let failure = serde_json::json!({"step":9,"seen":format!("{code}: distinct account screen evidence"),"screenshot":"screenshots/refusal-evidence.png"});
        let refusal = serde_json::json!({"verdict":"REFUSED","code":code,"message":"judgment refused","lease":"fixture-lease",
            "path":"walk","steps":steps,"blocks":blocks,"failure":failure,"jev":jev,"llmTurns":1,"escapes":2,"recoveries":3});
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!(
                "{}\n{}\n{}\n{}\n{}\n",
                envelope(2, "row", &row(0, "step")),
                envelope(3, "row", &steps[0].to_string()),
                envelope(4, "row", &steps[1].to_string()),
                envelope(5, "row", &steps[2].to_string()),
                envelope(6, "result", &refusal.to_string())
            ),
            Some(4),
        );
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        let receipt = run(&mut mock, &request(&repo, &app, 5));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.outcomes["core_exit"], "4");
        assert_eq!(receipt.failure.as_ref().unwrap().code, expected);
        assert_eq!(receipt.ledger.as_ref().unwrap().verdict, "REFUSED");
        assert_eq!(receipt.ledger.as_ref().unwrap().steps, 3);
        assert_eq!(receipt.ledger.as_ref().unwrap().failed_step, Some(9));
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_calls, 2);
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_input_tokens, 10);
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_median_ms, 25);
        let ledger: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&receipt.artifacts["ledger"]).unwrap()).unwrap();
        assert_eq!(ledger["jev"], jev);
        assert_eq!(ledger["failure"], failure);
        assert_eq!(ledger["steps"], steps);
        assert_eq!(ledger["blocks"], blocks);
        assert_eq!(ledger["path"], "walk");
        assert_eq!(ledger["llmTurns"], 1);
        assert_eq!(ledger["escapes"], 2);
        assert_eq!(ledger["recoveries"], 3);
        let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
        assert!(report.starts_with("# QaReN check: REFUSED"));
        assert!(report.contains("- ✓ line 1: Open tasks"));
        assert!(report.contains("- ✓ line 4: Check home"));
        assert!(report.contains("- ✗ line 9: Check account — judgment refused"));
        assert!(report.contains("![line 9](screenshots/row-nine.png)"));
        assert!(report.contains("![failure](screenshots/refusal-evidence.png)"));
        assert!(report.contains(&format!(
            "Step 9: {}: distinct account screen evidence",
            code.replace('_', "\\_")
        )));
        assert!(report.contains("- navigation: pass (discovered)"));
        assert!(report.contains("- account: fail (discovered)"));
        assert!(report.contains(&code.replace('_', "\\_")), "{report}");
        assert!(report.contains("jev.calls 2 · jev.medianMs 25 · jev.inputTokens 10"));
        assert!(report.contains("llmTurns 1 · escapes 2 · recoveries 3 · path walk"));
        assert_eq!(
            RunRecord::load(&repo.join("runs"), &run_id())
                .unwrap()
                .failure
                .unwrap()
                .code,
            expected
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn literal_plan_without_key_proceeds_past_preflight() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    let plan = std::fs::read(repo.join("test-app/plan.md")).unwrap();
    let output = serde_json::json!({"ok":true,"jevRequired":false,"prepared":{
        "hash":qaren::candidate::sha256_hex(&plan),"blocks":[]
    },"jev":{"calls":0,"medianMs":0,"inputTokens":0,"callDetails":[]}});
    script_inventory(&mut mock);
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput::success(&private_preflight(output).to_string()),
    );
    // No booted simulator ends the run at device selection, just past preflight.
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(r#"{"devices":{}}"#),
    );
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert!(labels(&mock).iter().any(|l| l == "simctl-list-booted"));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.preflight_jev.as_ref().unwrap().calls, 0);
    assert_ne!(
        receipt.failure.as_ref().map(|f| f.code.clone()),
        Some(FailureCode::JevUnreachable)
    );
}

#[test]
fn missing_jev_required_flag_is_treated_as_required() {
    for required in [None, Some(true)] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        let plan = std::fs::read(repo.join("test-app/plan.md")).unwrap();
        let mut output = serde_json::json!({"ok":true,"prepared":{
            "hash":qaren::candidate::sha256_hex(&plan),"blocks":[]
        },"jev":{"calls":0,"medianMs":0,"inputTokens":0,"callDetails":[]}});
        if let Some(required) = required {
            output["jevRequired"] = required.into();
        }
        script_inventory(&mut mock);
        mock.expect_run(
            "walk.js --preflight-stdin",
            CmdOutput::success(&private_preflight(output).to_string()),
        );
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.failure.unwrap().code, FailureCode::JevUnreachable);
        assert!(!repo.join(".locks").exists());
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn invalid_preflight_payload_cannot_claim_a_device() {
    for output in [
        "not json",
        r#"{"ok":true,"inputProtocol":1,"requiredInputs":[]}"#,
        r#"{"ok":true,"inputProtocol":1,"requiredInputs":[],"prepared":{"hash":"wrong","blocks":[]},"jev":{"calls":0,"medianMs":0}}"#,
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        mock.environment
            .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        script_inventory(&mut mock);
        mock.expect_run("walk.js --preflight-stdin", CmdOutput::success(output));
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.failure.unwrap().code, FailureCode::JevUnreachable);
        assert!(!repo.join(".locks").exists());
    }
}

#[test]
fn fresh_install_refuses_unknown_foreign_admission_before_mutation() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":"unknown"})
                .to_string(),
        ),
    );
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.failure.unwrap().phase, "fresh_install");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(record.resources.lease.is_none());
}

struct LeaseObservedRunner {
    mock: MockRunner,
    repo: PathBuf,
    wire: Option<String>,
    observed: Vec<String>,
    expect_fresh_install: bool,
}

impl LeaseObservedRunner {
    fn observe(&mut self, spec: &CmdSpec) {
        if spec.label != "fresh-install-admission" && self.wire.is_none() {
            return;
        }
        let record = RunRecord::load(&self.repo.join("runs"), &run_id()).unwrap();
        let lease = record
            .resources
            .lease
            .as_ref()
            .expect("durable lease during every owned phase");
        let holder = qaren::buildplan::read_holder(&lease.lock_dir).expect("lease lock present");
        assert_eq!(holder.run_id, record.run_id);
        assert_eq!(holder.holder, lease.holder);
        assert_eq!(record.resources.ios_simulator.as_ref().unwrap().udid, UDID);
        assert!(record.resources.device_borrowed);
        if matches!(spec.label.as_str(), "simctl-install" | "expo-run-ios") {
            assert_eq!(
                record.resources.fresh_install.is_some(),
                self.expect_fresh_install
            );
        }
        if self.expect_fresh_install
            && matches!(spec.label.as_str(), "simctl-install" | "expo-run-ios")
        {
            let stored = serde_json::to_value(&record).unwrap();
            assert_eq!(
                stored["resources"]["fresh_install"]["status"],
                "proven_absent"
            );
            assert_eq!(stored["resources"]["fresh_install"]["run_id"], run_id());
            assert_eq!(stored["resources"]["fresh_install"]["device_id"], UDID);
            assert_eq!(
                stored["resources"]["fresh_install"]["app_id"],
                "com.rndevagent.testapp"
            );
        }
        if let Some(wire) = &self.wire {
            assert_eq!(wire, &lease.wire(), "same lease spans all phases");
        } else {
            self.wire = Some(lease.wire());
        }
        self.observed.push(spec.label.clone());
    }
}

impl Runner for LeaseObservedRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.mock.env_var(name)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.observe(spec);
        self.mock.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.observe(spec);
        assert!(!RunRecord::run_dir(&self.repo.join("runs"), &run_id())
            .join("installed-apps.plist")
            .exists());
        self.mock.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.observe(spec);
        self.mock.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.observe(spec);
        self.mock.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.mock.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.mock.cancellation()
    }
}

fn script_admission(mock: &mut MockRunner) {
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":"clear"})
                .to_string(),
        ),
    );
}

#[test]
fn driver_appearing_during_deps_refuses_before_boot_or_reset_and_releases_the_lease() {
    for (fresh, boot) in [(true, false), (false, true), (true, true)] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        if boot {
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory("Shutdown"),
            );
        } else {
            script_preflight(&mut mock, &repo);
        }
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        mock.expect_run(
            &format!("fresh-install-preflight.js --platform ios --device {UDID}"),
            CmdOutput {
                exit_code: Some(4),
                stdout: serde_json::json!({
                    "v": 1, "platform": "ios", "deviceId": UDID, "status": "busy"
                })
                .to_string(),
                ..Default::default()
            },
        );
        let mut req = request(&repo, &app, 30);
        req.fresh_install = fresh;
        req.boot_device = boot;
        req.device = Some(if boot {
            UDID.to_lowercase()
        } else {
            UDID.into()
        });
        let mut runner = LeaseObservedRunner {
            mock,
            repo,
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: fresh,
        };

        let receipt = run(&mut runner, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::DeviceBusy);
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(receipt.cleanup["simulator"], "kept");
        assert_eq!(runner.mock.remaining(), 0);
        assert_eq!(
            runner.observed,
            [
                "fresh-install-admission",
                "pnpm-install",
                "expo-ios-build-help",
                "fresh-install-admission",
            ]
        );
        for scan in runner
            .mock
            .calls
            .iter()
            .filter(|c| c.label == "fresh-install-admission")
        {
            assert!(scan.args.windows(2).any(|args| args == ["--device", UDID]));
        }
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(record.phase, Phase::Failed);
        assert_eq!(record.failure.unwrap().code, FailureCode::DeviceBusy);
        assert!(record.resources.device_borrowed);
        assert!(record.resources.lease.is_none());
        assert!(record.resources.fresh_install.is_none());
        assert!(record.build.is_none());
        assert!(!req
            .lock_root
            .join(qaren::lease::lock_name(Platform::Ios, UDID))
            .exists());
    }
}

fn script_app_presence(mock: &mut MockRunner, installed: bool) {
    mock.expect_run(
        &format!("simctl listapps {UDID}"),
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

#[test]
fn fresh_install_reset_build_readiness_walk_and_teardown_share_one_durable_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_admission(&mut mock);
    script_app_presence(&mut mock, true);
    mock.expect_run(
        &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
        CmdOutput::success(""),
    );
    script_app_presence(&mut mock, false);
    script_provision_after_deps(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    let mut runner = LeaseObservedRunner {
        mock,
        repo: repo.clone(),
        wire: None,
        observed: Vec::new(),
        expect_fresh_install: true,
    };
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
    for key in ["admission_before_deps", "admission_before_mutation"] {
        let summary: serde_json::Value = serde_json::from_str(&receipt.outcomes[key]).unwrap();
        assert_eq!(summary["attempts"], 1);
        assert_eq!(summary["terminalReason"], "clear");
    }
    let lane = receipt
        .lane
        .as_ref()
        .expect("auto-selected fresh install owns the lane");
    assert_eq!(lane.device_id, UDID);
    assert_eq!(lane.hardware_keyboard, Some(false));
    assert_eq!(lane.first_screen, Some(true));
    assert!(runner
        .mock
        .calls
        .iter()
        .filter(|c| c.label == "simctl-lane-read")
        .all(|c| c.args[2] == UDID));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(runner.mock.remaining(), 0);
    assert_direct_ios_launch(&runner.mock);
    assert_subsequence(
        &runner.observed,
        &[
            "fresh-install-admission",
            "pnpm-install",
            "expo-ios-build-help",
            "fresh-install-admission",
            "simctl-listapps",
            "simctl-uninstall",
            "simctl-listapps",
            "expo-run-ios",
            "metro-status",
            "core-walk",
            "kill-group",
        ],
    );
    let child_request: serde_json::Value =
        serde_json::from_str(runner.mock.piped_stdin_text(1).trim()).unwrap();
    assert_eq!(child_request["payload"]["lease"], runner.wire.unwrap());
    assert_eq!(child_request["payload"]["target"]["warmLane"], true);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.lease.is_none());
    assert_eq!(
        serde_json::to_value(&receipt.fresh_install).unwrap(),
        serde_json::to_value(&record.resources.fresh_install).unwrap()
    );
    let stored = std::fs::read_to_string(RunRecord::path(&req.runs_root, &run_id())).unwrap();
    for output in [
        stored,
        receipt.to_json(),
        serde_json::to_string(&runner.mock.calls).unwrap(),
    ] {
        assert!(!output.contains("com.private.unrelated"));
        assert!(!output.contains("/private/fixture"));
    }
}

#[test]
fn fresh_install_resets_or_proves_absence_before_cached_install_under_the_same_lease() {
    use qaren::buildplan::{self, ArtifactKind, NativeCacheState, CACHE_SCHEMA};
    for installed in [false, true] {
        let (repo, app) = app_repo();
        std::fs::write(
            app.join(".qaren/config.yaml"),
            "appId: com.rndevagent.testapp\nmetroPort: 8791\ndevClientScheme: rndatest\n",
        )
        .unwrap();
        let cached = repo.join("cached/testapp.app");
        common::write_ios_app(&cached);
        let mut fp_mock = MockRunner::new();
        fp_mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut fp_mock);
        let fp = qaren::fingerprint::compute(&mut fp_mock, &repo, &app, "ios").unwrap();
        common::seed_store(
            &repo.join(".native-store"),
            "ios",
            &fp.value,
            &cached,
            ArtifactKind::AppBundle,
        );
        buildplan::save_json(
            &buildplan::state_path(&repo, "ios", "com.rndevagent.testapp"),
            &NativeCacheState {
                schema: CACHE_SCHEMA.to_string(),
                fingerprint_parts: Default::default(),
                platform: "ios".into(),
                app_id: "com.rndevagent.testapp".into(),
                worktree_root: repo.canonicalize().unwrap(),
                fingerprint: fp.value,
                built_at: "2026-08-13T00:00:00Z".into(),
                candidate_sha: "a".repeat(40),
                lockfile_sha256: "c".repeat(64),
                generated_native_dirs: vec!["ios".into()],
                artifact: None,
            },
        )
        .unwrap();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        if installed {
            script_app_presence(&mut mock, true);
            mock.expect_run(
                &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                CmdOutput::success(""),
            );
        }
        script_app_presence(&mut mock, false);
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        common::script_ios_app_verification(&mut mock);
        mock.expect_spawn(
            "expo start",
            Spawned {
                pid: 6000,
                pgid: 6000,
            },
        );
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("node expo start"));
        mock.expect_run(&format!("simctl install {UDID}"), CmdOutput::success(""));
        for launch in [true, false] {
            mock.expect_run("ps", CmdOutput::success(LSTART));
            mock.expect_run("ps", CmdOutput::success("S"));
            mock.expect_run("lsof", CmdOutput::success("6001"));
            mock.expect_run("ps", CmdOutput::success("6000"));
            mock.expect_run("curl", CmdOutput::success("packager-status:running"));
            if launch {
                mock.expect_run("qaren-request-probe", CmdOutput::success(""));
                mock.expect_run("expo-platform", CmdOutput::success(""));
                mock.expect_run("expo-platform", CmdOutput::success(""));
                common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
                mock.expect_run(
                    &format!("simctl launch --terminate-running-process {UDID}"),
                    CmdOutput::success(""),
                );
            }
        }
        mock.expect_run(
            "simctl get_app_container",
            CmdOutput::success("/containers/app"),
        );
        mock.expect_run(
            "simctl spawn",
            CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
        );
        mock.expect_run("simctl spawn", CmdOutput::success(common::APP_RUNNING));
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        let mut runner = LeaseObservedRunner {
            mock,
            repo: repo.clone(),
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: true,
        };
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(
            receipt.build.unwrap().decision,
            buildplan::BuildDecision::Reuse
        );
        assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(runner.mock.remaining(), 0);
        assert_direct_ios_launch(&runner.mock);
        assert_subsequence(
            &runner.observed,
            &[
                "fresh-install-admission",
                "pnpm-install",
                "expo-ios-build-help",
                "fresh-install-admission",
                "simctl-listapps",
                "simctl-install",
                "metro-status",
                "core-walk",
                "kill-group",
            ],
        );
        assert_eq!(
            runner
                .observed
                .iter()
                .filter(|label| *label == "simctl-uninstall")
                .count(),
            usize::from(installed)
        );
        assert!(!runner.observed.iter().any(|label| label == "expo-run-ios"));
    }
}

#[test]
fn fresh_install_and_boot_device_require_valid_matching_clear_admission_with_success_exit() {
    let response = |status: &str, device: &str| {
        serde_json::json!({
            "v":1, "platform":"ios", "deviceId":device, "status":status,
        })
        .to_string()
    };
    for (fresh, boot, after_deps) in [
        (true, false, false),
        (false, true, false),
        (true, true, false),
        (true, false, true),
        (false, true, true),
        (true, true, true),
    ] {
        for (output, expected) in [
            (
                CmdOutput::failed(1, "entry point missing"),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success("not json"),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success(&response("clear", OTHER_UDID)),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success(&response("cleared", UDID)),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("clear", UDID),
                    ..Default::default()
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success(&response("clear", UDID))
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("unknown", UDID),
                    ..Default::default()
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: serde_json::json!({
                        "v": 1, "platform": "ios", "deviceId": UDID, "status": "unknown",
                        "evidence": { "reason": "scan_row_invalid" }
                    })
                    .to_string(),
                    ..Default::default()
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("busy", UDID),
                    ..Default::default()
                },
                FailureCode::DeviceBusy,
            ),
        ] {
            let reported_scan_reason = output.stdout.contains("scan_row_invalid");
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            if boot {
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory("Shutdown"),
                );
            } else {
                script_preflight(&mut mock, &repo);
            }
            if after_deps {
                script_admission(&mut mock);
                common::script_ios_deps(&mut mock);
            }
            mock.expect_run("fresh-install-preflight.js", output);
            let mut req = request(&repo, &app, 30);
            req.fresh_install = fresh;
            req.boot_device = boot;
            req.device = Some(UDID.to_string()).filter(|_| boot);
            let mut runner = LeaseObservedRunner {
                mock,
                repo,
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let receipt = run(&mut runner, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused);
            if reported_scan_reason {
                assert!(receipt
                    .failure
                    .as_ref()
                    .unwrap()
                    .detail
                    .as_str()
                    .contains("scan_row_invalid"));
            }
            assert_eq!(receipt.failure.unwrap().code, expected);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            let expected_phases = if after_deps {
                vec![
                    "fresh-install-admission",
                    "pnpm-install",
                    "expo-ios-build-help",
                    "fresh-install-admission",
                ]
            } else {
                vec!["fresh-install-admission"]
            };
            assert_eq!(runner.observed, expected_phases);
            assert_eq!(runner.mock.remaining(), 0);
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            if reported_scan_reason {
                assert!(record
                    .failure
                    .as_ref()
                    .unwrap()
                    .detail
                    .as_str()
                    .contains("scan_row_invalid"));
            }
            assert_eq!(record.failure.unwrap().code, expected);
        }
    }
}

#[test]
fn fresh_install_unknown_inventory_never_authorizes_install_or_build() {
    for after_uninstall in [false, true] {
        for (list, converted) in [
            (CmdOutput::failed(1, "simulator unavailable"), None),
            (
                CmdOutput {
                    stderr: "incomplete inventory".into(),
                    ..CmdOutput::success("{}")
                },
                None,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success("{}")
                },
                None,
            ),
            (
                CmdOutput::success("bad plist"),
                Some(CmdOutput::failed(1, "invalid plist")),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput::success("not json")),
            ),
            (CmdOutput::success("plist"), Some(CmdOutput::success("[]"))),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput::success(r#"{"error":{}}"#)),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput {
                    stderr: "incomplete conversion".into(),
                    ..CmdOutput::success("{}")
                }),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success("{}")
                }),
            ),
        ] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight(&mut mock, &repo);
            script_admission(&mut mock);
            common::script_ios_deps(&mut mock);
            script_admission(&mut mock);
            if after_uninstall {
                script_app_presence(&mut mock, true);
                mock.expect_run("simctl uninstall", CmdOutput::success(""));
            }
            mock.expect_run("simctl listapps", list);
            if let Some(output) = converted {
                mock.expect_run("plutil -convert json", output);
            }
            let mut req = request(&repo, &app, 30);
            req.fresh_install = true;
            let receipt = run(&mut mock, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert_eq!(
                receipt.failure.unwrap().code,
                FailureCode::AppPresenceUnknown
            );
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(mock.remaining(), 0);
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            assert_eq!(
                record.failure.unwrap().code,
                FailureCode::AppPresenceUnknown
            );
        }
    }
}

#[test]
fn fresh_install_requires_uninstall_success_and_proven_absence() {
    for output in [
        CmdOutput::failed(1, "denied"),
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
        CmdOutput::success(""),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        script_app_presence(&mut mock, true);
        let ok = output.ok();
        mock.expect_run("simctl uninstall", output);
        if ok {
            script_app_presence(&mut mock, true);
        }
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::AppResetFailed);
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(mock.remaining(), 0);
        assert_eq!(
            RunRecord::load(&req.runs_root, &run_id()).unwrap().phase,
            Phase::Failed
        );
    }
}

fn available_inventory(state: &str) -> String {
    let mut inventory: serde_json::Value = serde_json::from_str(&booted_json_two()).unwrap();
    let sims = inventory["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-5"]
        .as_array_mut()
        .unwrap();
    for sim in sims.iter_mut() {
        sim["isAvailable"] = true.into();
    }
    sims[0]["state"] = state.into();
    inventory.to_string()
}

#[test]
fn boot_device_selection_refuses_unknown_inventory_without_claiming_or_falling_back() {
    let available = available_inventory("Shutdown");
    for restart in [false, true] {
        for output in [
            CmdOutput::failed(1, "unavailable"),
            CmdOutput::success("not json"),
            CmdOutput::success("{}"),
            CmdOutput::success(&available.replace(UDID, &UDID.to_lowercase())),
            CmdOutput::success(&available.replace(UDID, OTHER_UDID)),
            CmdOutput::success(&available.replace(OTHER_UDID, UDID)),
            CmdOutput::success(&available.replace("Shutdown", "Booting")),
            CmdOutput::success(&available.replace("iOS-26-5", "watchOS-26-5")),
            CmdOutput::success(&available.replace("\"isAvailable\":true", "\"isAvailable\":false")),
            CmdOutput {
                stderr: "incomplete".into(),
                ..CmdOutput::success(&available)
            },
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success(&available)
            },
        ] {
            let (repo, app) = app_repo();
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.into());
            req.boot_device = !restart;
            req.restart_device = restart;
            let mut mock = MockRunner::new();
            mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
            script_plan(&mut mock, &repo);
            mock.expect_run("simctl list devices -j", output);
            let receipt = run(&mut mock, &req);
            assert_eq!(
                receipt.failure.unwrap().code,
                FailureCode::DeviceUnavailable,
                "restart={restart}"
            );
            assert_eq!(mock.remaining(), 0);
            assert!(!req.lock_root.exists());
            assert!(!req.runs_root.exists());
        }
    }
}

#[test]
fn without_boot_device_a_shutdown_selection_still_refuses_even_with_a_booted_ambient_simulator() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &available_inventory("Shutdown"));
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    let receipt = run(&mut mock, &req);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.exists());
    assert!(!req.runs_root.exists());
}

#[test]
fn boot_device_failure_or_timeout_stops_before_readback_reset_install_or_walk() {
    for fresh in [false, true] {
        for output in [
            CmdOutput::failed(1, "boot failed"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("")
            },
        ] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory("Shutdown"),
            );
            script_admission(&mut mock);
            common::script_ios_deps(&mut mock);
            script_admission(&mut mock);
            mock.expect_run(&format!("simctl bootstatus {UDID} -b"), output);
            let mut runner = LeaseObservedRunner {
                mock,
                repo: repo.clone(),
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.into());
            req.boot_device = true;
            req.fresh_install = fresh;
            let receipt = run(&mut runner, &req);
            assert_eq!(receipt.result, ReceiptResult::Failed);
            assert_eq!(
                receipt.failure.unwrap().code,
                FailureCode::SimulatorBootFailed
            );
            assert_eq!(
                runner.observed,
                [
                    "fresh-install-admission",
                    "pnpm-install",
                    "expo-ios-build-help",
                    "fresh-install-admission",
                    "simctl-bootstatus"
                ]
            );
            assert_eq!(runner.mock.remaining(), 0);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(receipt.cleanup["simulator"], "kept");
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            assert_eq!(
                record.failure.unwrap().code,
                FailureCode::SimulatorBootFailed
            );
            assert!(record.resources.device_borrowed);
            assert!(record.resources.lease.is_none());
            assert!(record.resources.fresh_install.is_none());
        }
    }
}

#[test]
fn boot_device_readback_must_prove_exact_booted_target_and_unchanged_runtime_and_type() {
    let ready = available_inventory("Booted");
    for fresh in [false, true] {
        for initial in ["Shutdown", "Booted"] {
            for output in [
                CmdOutput::failed(1, "inventory failed"),
                CmdOutput::success("not json"),
                CmdOutput::success(&available_inventory("Shutdown")),
                CmdOutput::success(&ready.replace(UDID, OTHER_UDID)),
                CmdOutput::success(&ready.replace(OTHER_UDID, UDID)),
                CmdOutput::success(&ready.replace(UDID, &UDID.to_lowercase())),
                CmdOutput::success(&ready.replace("iOS-26-5", "iOS-26-4")),
                CmdOutput::success(&ready.replace("iPhone-17", "iPhone-16")),
                CmdOutput::success(&ready.replace("\"isAvailable\":true", "\"isAvailable\":false")),
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success(&ready)
                },
                CmdOutput {
                    stderr: "incomplete".into(),
                    ..CmdOutput::success(&ready)
                },
            ] {
                let (repo, app) = app_repo();
                let mut mock = MockRunner::new();
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory(initial),
                );
                script_admission(&mut mock);
                common::script_ios_deps(&mut mock);
                script_admission(&mut mock);
                if initial == "Shutdown" {
                    mock.expect_run(
                        &format!("simctl bootstatus {UDID} -b"),
                        CmdOutput::success(""),
                    );
                }
                mock.expect_run("simctl list devices -j", output);
                let mut runner = LeaseObservedRunner {
                    mock,
                    repo: repo.clone(),
                    wire: None,
                    observed: Vec::new(),
                    expect_fresh_install: fresh,
                };
                let mut req = request(&repo, &app, 30);
                req.device = Some(UDID.into());
                req.boot_device = true;
                req.fresh_install = fresh;
                let receipt = run(&mut runner, &req);
                assert_eq!(receipt.result, ReceiptResult::Failed);
                assert_eq!(
                    receipt.failure.unwrap().code,
                    FailureCode::SimulatorBootFailed
                );
                let expected = if initial == "Shutdown" {
                    vec![
                        "fresh-install-admission",
                        "pnpm-install",
                        "expo-ios-build-help",
                        "fresh-install-admission",
                        "simctl-bootstatus",
                        "simctl-list",
                    ]
                } else {
                    vec![
                        "fresh-install-admission",
                        "pnpm-install",
                        "expo-ios-build-help",
                        "fresh-install-admission",
                        "simctl-list",
                    ]
                };
                assert_eq!(runner.observed, expected);
                assert_eq!(runner.mock.remaining(), 0);
                assert_eq!(receipt.cleanup["device_lease"], "removed");
                assert_eq!(receipt.cleanup["simulator"], "kept");
                let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
                assert_eq!(
                    record.failure.unwrap().code,
                    FailureCode::SimulatorBootFailed
                );
                assert!(record.resources.device_borrowed);
                assert!(record.resources.lease.is_none());
                assert!(record.resources.fresh_install.is_none());
            }
        }
    }
}

#[test]
fn boot_device_refreshes_the_selected_state_after_reclaim_shuts_down_the_simulator() {
    use qaren::runrecord::{BorrowedIosStop, IosSimResource};
    let (repo, app) = app_repo();
    plant_holder(&repo, |record| {
        record.phase = Phase::Ready;
        record.scenario.ios = Some(qaren::scenario::IosSpec {
            device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5".into(),
            max_devices: None,
        });
        record.resources.ios_simulator = Some(IosSimResource {
            udid: UDID.into(),
            name: "qa-company-app".into(),
            device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5".into(),
        });
        record.resources.arm_borrowed_ios_stop().unwrap();
    });
    let mut mock = MockRunner::new();
    script_preflight_inventory_until_lease(
        &mut mock,
        &repo,
        "simctl list devices -j",
        &available_inventory("Booted"),
    );
    mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(""));
    mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(""));
    script_admission(&mut mock);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Booted")),
    );
    mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Shutdown")),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Shutdown")),
    );
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_admission(&mut mock);
    mock.expect_run(
        &format!("simctl bootstatus {UDID} -b"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Booted")),
    );
    script_provision_after_deps(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    req.boot_device = true;
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    assert_subsequence(
        &labels(&mock),
        &[
            "simctl-shutdown",
            "simctl-list",
            "simctl-list",
            "simctl-bootstatus",
            "simctl-list",
            "core-walk",
        ],
    );
    for label in ["simctl-shutdown", "simctl-bootstatus"] {
        let calls: Vec<_> = mock
            .calls
            .iter()
            .filter(|spec| spec.label == label)
            .collect();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].args.contains(&UDID.to_string()));
    }
    assert!(!mock
        .calls
        .iter()
        .any(|spec| matches!(spec.label.as_str(), "simctl-delete" | "simctl-uninstall")));
    let earlier = RunRecord::load(&req.runs_root, "check-earlier").unwrap();
    assert_eq!(earlier.phase, Phase::Cleaned);
    assert_eq!(
        earlier.resources.borrowed_ios_stop(),
        BorrowedIosStop::Completed
    );
    assert!(earlier.resources.lease.is_none());
    let current = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(
        current.resources.borrowed_ios_stop(),
        BorrowedIosStop::NotArmed
    );
    assert!(current.resources.lease.is_none());
}

#[test]
fn a_cold_first_screen_refuses_the_leg_before_row_one_and_is_recorded_once() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_inventory(
        &mut mock,
        &repo,
        "simctl list devices -j",
        &available_inventory("Booted"),
    );
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_admission(&mut mock);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Booted")),
    );
    script_provision_after_deps(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    let refusal = serde_json::json!({"verdict":"REFUSED","code":"LANE_NOT_WARM",
        "message":"no text was observed on the app's first screen","lease":"fixture-lease"});
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", &refusal.to_string())),
        Some(4),
    );
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    let mut runner = LeaseObservedRunner {
        mock,
        repo: repo.clone(),
        wire: None,
        observed: Vec::new(),
        expect_fresh_install: false,
    };
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.to_string());
    req.boot_device = true;

    let receipt = run(&mut runner, &req);

    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.outcomes["core_exit"], "4");
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::LaneNotWarm);
    assert!(failure.code.is_refusal());
    let lane = receipt.lane.as_ref().expect("the warm-lane record");
    assert_eq!(lane.first_screen, Some(false));
    assert_eq!(receipt.ledger.as_ref().unwrap().steps, 0);
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn boot_device_admission_boot_readback_and_walk_share_a_durable_borrowed_lease() {
    for fresh in [false, true] {
        for initial in ["Shutdown", "Booted"] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory(initial),
            );
            script_admission(&mut mock);
            common::script_ios_deps(&mut mock);
            script_admission(&mut mock);
            if initial == "Shutdown" {
                mock.expect_run(
                    &format!("simctl bootstatus {UDID} -b"),
                    CmdOutput::success(""),
                );
            }
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
            if fresh {
                script_app_presence(&mut mock, true);
                mock.expect_run(
                    &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                    CmdOutput::success(""),
                );
                script_app_presence(&mut mock, false);
            }
            script_provision_after_deps(&mut mock);
            script_drift_status(&mut mock);
            script_host_probe(&mut mock, UDID, hosts_absent());
            mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
            script_core_identity(&mut mock);
            script_teardown(&mut mock);
            let mut runner = LeaseObservedRunner {
                mock,
                repo: repo.clone(),
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.to_lowercase());
            req.boot_device = true;
            req.fresh_install = fresh;
            let receipt = run(&mut runner, &req);
            assert_eq!(
                receipt.result,
                ReceiptResult::Pass,
                "{initial} fresh={fresh}: {:?}",
                receipt.failure
            );
            assert_eq!(runner.mock.remaining(), 0);
            let lane = receipt.lane.as_ref().expect("an owned lane is pinned");
            assert_eq!(lane.device_id, UDID);
            assert_eq!(lane.first_screen, Some(true));
            let request_line: serde_json::Value =
                serde_json::from_str(runner.mock.piped_stdin_text(1).trim()).unwrap();
            assert_eq!(request_line["payload"]["target"]["warmLane"], true);
            let lane_reads: Vec<_> = runner
                .mock
                .calls
                .iter()
                .filter(|c| c.label == "simctl-lane-read")
                .collect();
            assert_eq!(lane_reads.len(), 2);
            assert!(lane_reads.iter().all(|c| c.args[2] == UDID));
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(receipt.cleanup["simulator"], "kept");
            let mut phases = vec![
                "fresh-install-admission",
                "pnpm-install",
                "expo-ios-build-help",
                "fresh-install-admission",
            ];
            if initial == "Shutdown" {
                phases.push("simctl-bootstatus");
            }
            phases.push("simctl-list");
            if fresh {
                phases.extend(["simctl-listapps", "simctl-uninstall", "simctl-listapps"]);
            }
            phases.extend(["expo-run-ios", "metro-status", "core-walk", "kill-group"]);
            assert_subsequence(&runner.observed, &phases);
            for spec in &runner.mock.calls {
                assert!(!spec.rendered().contains(OTHER_UDID));
                assert!(!matches!(
                    spec.label.as_str(),
                    "simctl-create" | "simctl-shutdown" | "simctl-delete"
                ));
                if spec.label == "simctl-bootstatus" {
                    assert_eq!(spec.args, ["simctl", "bootstatus", UDID, "-b"]);
                    assert_eq!(
                        spec.timeout_seconds,
                        qaren::scenario::Deadlines::default().device_boot_seconds
                    );
                }
                if spec.label == "simctl-list" {
                    assert_eq!(spec.timeout_seconds, 30);
                }
                if spec.label == "expo-run-ios" {
                    assert!(spec
                        .args
                        .windows(2)
                        .any(|args| args == ["--device", "generic"]));
                    assert!(spec.args.contains(&"--no-bundler".into()));
                }
                if matches!(spec.label.as_str(), "simctl-install" | "simctl-launch") {
                    assert_eq!(
                        spec.args[if spec.label == "simctl-launch" { 3 } else { 2 }],
                        UDID
                    );
                }
            }
            if !fresh {
                assert!(!runner
                    .observed
                    .iter()
                    .any(|l| matches!(l.as_str(), "simctl-listapps" | "simctl-uninstall")));
                assert!(receipt.fresh_install.is_none());
            }
            assert_eq!(
                runner
                    .observed
                    .iter()
                    .filter(|l| *l == "simctl-bootstatus")
                    .count(),
                usize::from(initial == "Shutdown")
            );
            let child: serde_json::Value =
                serde_json::from_str(runner.mock.piped_stdin_text(1).trim()).unwrap();
            assert_eq!(child["payload"]["target"]["deviceId"], UDID);
            assert_eq!(child["payload"]["lease"], runner.wire.unwrap());
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert!(record.resources.device_borrowed);
            assert!(record.resources.lease.is_none());
            assert_eq!(record.resources.fresh_install.is_some(), fresh);
            assert!(!req
                .lock_root
                .join(qaren::lease::lock_name(Platform::Ios, UDID))
                .exists());
        }
    }
}

#[test]
fn external_cleanup_refuses_a_live_restart_only_run_during_dependency_install() {
    struct CleanupDuringDeps {
        mock: MockRunner,
        runs_root: PathBuf,
        checked: bool,
    }
    impl Runner for CleanupDuringDeps {
        fn env_var(&self, name: &str) -> Option<String> {
            self.mock.env_var(name)
        }
        fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
            if spec.label == "pnpm-install" {
                let record = RunRecord::load(&self.runs_root, &run_id()).unwrap();
                assert_eq!(record.phase, Phase::Created);
                assert_eq!(
                    record.resources.borrowed_ios_stop(),
                    qaren::runrecord::BorrowedIosStop::NotArmed
                );
                assert!(record.resources.core.is_none());
                assert!(record.resources.runner_drivers.is_empty());
                let owner = record.prepare.as_ref().unwrap();
                let before = std::fs::read(RunRecord::path(&self.runs_root, &run_id())).unwrap();
                let mut cleanup_runner = MockRunner::new();
                cleanup_runner.expect_run(
                    &format!("ps -p {} -o lstart=", owner.pid),
                    CmdOutput::success(&owner.started_at),
                );
                cleanup_runner.expect_run(
                    &format!("ps -p {} -o stat=", owner.pid),
                    CmdOutput::success("S"),
                );
                let receipt = qaren::commands::cleanup::cleanup(
                    &mut cleanup_runner,
                    &self.runs_root,
                    &run_id(),
                );
                assert_eq!(receipt.result, ReceiptResult::Refused);
                assert!(receipt.cleanup["simulator"].starts_with("refused:"));
                let lease = record.resources.lease.as_ref().unwrap();
                let holder = qaren::buildplan::read_holder(&lease.lock_dir).unwrap();
                assert_eq!(holder.run_id, record.run_id);
                assert_eq!(holder.holder, lease.holder);
                assert_eq!(
                    std::fs::read(RunRecord::path(&self.runs_root, &run_id())).unwrap(),
                    before
                );
                assert_eq!(cleanup_runner.calls.len(), 2);
                assert_eq!(cleanup_runner.remaining(), 0);
                assert!(!receipt.outcomes.contains_key("record_saved"));
                self.checked = true;
            }
            self.mock.execute(spec, interruptible)
        }
        fn execute_private(
            &mut self,
            spec: &CmdSpec,
            input: &[u8],
            interruptible: bool,
        ) -> qaren::exec::PrivateOutput {
            self.mock.execute_private(spec, input, interruptible)
        }
        fn spawn_group_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<Spawned> {
            self.mock.spawn_group_unchecked(spec, log)
        }
        fn spawn_piped_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<PipedChild> {
            self.mock.spawn_piped_unchecked(spec, log)
        }
        fn sleep(&mut self, duration: std::time::Duration) {
            self.mock.sleep(duration)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.mock.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.mock.commands_executed()
        }
    }
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_inventory(
        &mut mock,
        &repo,
        "simctl list devices -j",
        &available_inventory("Booted"),
    );
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_unknown_admission(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    req.restart_device = true;
    let mut runner = CleanupDuringDeps {
        mock,
        runs_root: req.runs_root.clone(),
        checked: false,
    };
    let receipt = run(&mut runner, &req);
    assert!(runner.checked);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn restart_device_shuts_down_boots_reads_back_and_walks_under_a_durable_borrowed_lease() {
    for fresh in [false, true] {
        for initial in ["Shutdown", "Booted"] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory(initial),
            );
            script_admission(&mut mock);
            common::script_ios_deps(&mut mock);
            script_admission(&mut mock);
            if initial == "Booted" {
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory(initial)),
                );
                mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Shutdown")),
                );
            }
            mock.expect_run(
                &format!("simctl bootstatus {UDID} -b"),
                CmdOutput::success(""),
            );
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
            if fresh {
                script_app_presence(&mut mock, true);
                mock.expect_run(
                    &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                    CmdOutput::success(""),
                );
                script_app_presence(&mut mock, false);
            }
            script_provision_after_deps(&mut mock);
            script_drift_status(&mut mock);
            script_host_probe(&mut mock, UDID, hosts_absent());
            mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
            script_core_identity(&mut mock);
            script_teardown(&mut mock);
            let mut runner = LeaseObservedRunner {
                mock,
                repo: repo.clone(),
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.to_lowercase());
            req.restart_device = true;
            req.fresh_install = fresh;
            let receipt = run(&mut runner, &req);
            assert_eq!(
                receipt.result,
                ReceiptResult::Pass,
                "{initial} fresh={fresh}: {:?}",
                receipt.failure
            );
            assert_eq!(runner.mock.remaining(), 0);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(receipt.cleanup["simulator"], "kept");
            let mut phases = vec![
                "fresh-install-admission",
                "pnpm-install",
                "expo-ios-build-help",
                "fresh-install-admission",
            ];
            if initial == "Booted" {
                phases.extend(["simctl-list", "simctl-shutdown", "simctl-list"]);
            }
            phases.extend(["simctl-bootstatus", "simctl-list"]);
            if fresh {
                phases.extend(["simctl-listapps", "simctl-uninstall", "simctl-listapps"]);
            }
            phases.extend(["expo-run-ios", "metro-status", "core-walk", "kill-group"]);
            assert_subsequence(&runner.observed, &phases);
            assert_eq!(
                runner
                    .observed
                    .iter()
                    .filter(|l| *l == "simctl-shutdown")
                    .count(),
                usize::from(initial == "Booted")
            );
            assert_eq!(
                runner
                    .observed
                    .iter()
                    .filter(|l| *l == "simctl-bootstatus")
                    .count(),
                1
            );
            for spec in &runner.mock.calls {
                assert!(!spec.rendered().contains(OTHER_UDID));
                assert!(!matches!(
                    spec.label.as_str(),
                    "simctl-create" | "simctl-delete"
                ));
                if spec.label == "simctl-shutdown" {
                    assert_eq!(spec.args, ["simctl", "shutdown", UDID]);
                }
            }
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert!(record.resources.device_borrowed);
            assert_eq!(
                record.resources.borrowed_ios_stop(),
                qaren::runrecord::BorrowedIosStop::NotArmed
            );
            assert!(record.resources.lease.is_none());
        }
    }
}

#[test]
fn restart_device_shutdown_or_readback_failure_stops_before_boot_install_or_walk() {
    for fault in [
        "pre_list_failed",
        "shutdown_failed",
        "shutdown_timeout",
        "readback_still_booted",
        "readback_changed_runtime",
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices -j",
            &available_inventory("Booted"),
        );
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        match fault {
            "pre_list_failed" => {
                mock.expect_run("simctl list devices -j", CmdOutput::failed(1, "list error"));
            }
            "shutdown_failed" => {
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {UDID}"),
                    CmdOutput::failed(1, "shutdown denied"),
                );
            }
            "shutdown_timeout" => {
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {UDID}"),
                    CmdOutput {
                        timed_out: true,
                        ..CmdOutput::success("")
                    },
                );
            }
            "readback_still_booted" => {
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
            }
            "readback_changed_runtime" => {
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(
                        &available_inventory("Shutdown").replace("iOS-26-5", "iOS-26-4"),
                    ),
                );
            }
            _ => unreachable!(),
        }
        let mut runner = LeaseObservedRunner {
            mock,
            repo: repo.clone(),
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: false,
        };
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.restart_device = true;
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Failed, "{fault}");
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::SimulatorBootFailed,
            "{fault}"
        );
        assert!(!runner.observed.iter().any(|l| matches!(
            l.as_str(),
            "simctl-bootstatus" | "simctl-install" | "simctl-launch" | "core-walk"
        )));
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(
            record.resources.borrowed_ios_stop(),
            qaren::runrecord::BorrowedIosStop::NotArmed,
            "{fault}"
        );
        if fault == "pre_list_failed" {
            assert_eq!(receipt.cleanup["device_lease"], "removed", "{fault}");
            assert!(record.resources.lease.is_none());
        } else {
            assert!(
                receipt.cleanup["device_lease"].starts_with("unresolved:"),
                "{fault}"
            );
            assert!(record.resources.lease.as_ref().unwrap().lock_dir.exists());
        }
        assert_eq!(
            runner
                .observed
                .iter()
                .filter(|l| *l == "simctl-shutdown")
                .count(),
            usize::from(fault != "pre_list_failed"),
            "{fault}"
        );
        assert_eq!(receipt.cleanup["simulator"], "kept", "{fault}");
        assert_eq!(runner.mock.remaining(), 0, "{fault}");
    }
}

#[test]
fn shutdown_only_selection_refuses_unavailable_or_ambiguous_targets_before_claiming() {
    for fault in ["missing", "false", "non_boolean", "duplicate", "shutdown"] {
        let (repo, app) = app_repo();
        let mut inventory: serde_json::Value =
            serde_json::from_str(&available_inventory("Booted")).unwrap();
        let sims = inventory["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-5"]
            .as_array_mut()
            .unwrap();
        match fault {
            "missing" => {
                sims[0].as_object_mut().unwrap().remove("isAvailable");
            }
            "false" => sims[0]["isAvailable"] = false.into(),
            "non_boolean" => sims[0]["isAvailable"] = "true".into(),
            "duplicate" => {
                let mut duplicate = sims[0].clone();
                duplicate["state"] = "Shutdown".into();
                sims.push(duplicate);
            }
            "shutdown" => sims[0]["state"] = "Shutdown".into(),
            _ => unreachable!(),
        }
        let mut mock = MockRunner::new();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1"));
        script_plan(&mut mock, &repo);
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&inventory.to_string()),
        );
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.shutdown_device_on_exit = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::DeviceUnavailable,
            "{fault}"
        );
        assert_eq!(mock.remaining(), 0);
        assert!(!req.lock_root.exists(), "{fault}");
        assert!(!req.runs_root.exists(), "{fault}");
        assert!(!mock.calls.iter().any(|spec| matches!(
            spec.label.as_str(),
            "fresh-install-admission" | "pnpm-install" | "simctl-shutdown"
        )));
    }
}

#[test]
fn shutdown_device_on_exit_arms_after_admission_and_stops_simulator_before_releasing_lease() {
    use qaren::runrecord::BorrowedIosStop;
    for (mode, end_state) in [
        ("booted_only", "Booted"),
        ("booted_only", "Shutdown"),
        ("with_boot_device", "Booted"),
        ("with_restart_device", "Booted"),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        match mode {
            "booted_only" => {
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory("Booted"),
                );
            }
            "with_boot_device" => {
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory("Shutdown"),
                );
            }
            "with_restart_device" => {
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory("Booted"),
                );
            }
            _ => unreachable!(),
        }
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        if mode == "with_boot_device" {
            mock.expect_run(
                &format!("simctl bootstatus {UDID} -b"),
                CmdOutput::success(""),
            );
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
        } else if mode == "with_restart_device" {
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
            mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Shutdown")),
            );
            mock.expect_run(
                &format!("simctl bootstatus {UDID} -b"),
                CmdOutput::success(""),
            );
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
        }
        script_provision_after_deps(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        // Teardown's borrowed-iOS stop leg runs under the same lease!
        script_admission(&mut mock);
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&available_inventory(end_state)),
        );
        if end_state == "Booted" {
            mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Shutdown")),
            );
        }
        let mut runner = LeaseObservedRunner {
            mock,
            repo: repo.clone(),
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: false,
        };
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.to_lowercase());
        req.boot_device = mode == "with_boot_device";
        req.restart_device = mode == "with_restart_device";
        req.shutdown_device_on_exit = true;
        let receipt = run(&mut runner, &req);
        assert_eq!(
            receipt.result,
            ReceiptResult::Pass,
            "{mode} {end_state}: {:?}",
            receipt.failure
        );
        assert_eq!(
            receipt.cleanup["simulator"],
            if end_state == "Booted" {
                "removed"
            } else {
                "absent"
            },
            "{mode} {end_state}"
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(runner.mock.remaining(), 0, "{mode} {end_state}");
        assert_subsequence(
            &runner.observed,
            if end_state == "Booted" {
                &[
                    "core-walk",
                    "kill-group",
                    "fresh-install-admission",
                    "simctl-list",
                    "simctl-shutdown",
                    "simctl-list",
                ]
            } else {
                &[
                    "core-walk",
                    "kill-group",
                    "fresh-install-admission",
                    "simctl-list",
                ]
            },
        );
        for spec in &runner.mock.calls {
            assert!(!spec.rendered().contains(OTHER_UDID));
            assert!(!matches!(
                spec.label.as_str(),
                "simctl-create" | "simctl-delete"
            ));
        }
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(record.phase, Phase::Cleaned);
        assert_eq!(
            record.resources.borrowed_ios_stop(),
            BorrowedIosStop::Completed
        );
        assert!(record.resources.lease.is_none());
    }
}

#[test]
fn shutdown_device_on_exit_keeps_simulator_when_cancelled_before_arm_and_stops_it_when_cancelled_after_arm(
) {
    use qaren::runrecord::BorrowedIosStop;
    for stage in ["before_arm", "after_arm"] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices -j",
            &available_inventory("Shutdown"),
        );
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        if stage == "before_arm" {
            mock.cancel_after = Some(("expo run:ios --help".into(), "received SIGINT".into()));
        } else {
            script_admission(&mut mock);
            mock.expect_run(
                &format!("simctl bootstatus {UDID} -b"),
                CmdOutput::success(""),
            );
            mock.cancel_after = Some(("simctl bootstatus".into(), "received SIGINT".into()));
            script_admission(&mut mock);
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
            mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Shutdown")),
            );
        }
        let mut runner = LeaseObservedRunner {
            mock,
            repo: repo.clone(),
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: false,
        };
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.boot_device = true;
        req.shutdown_device_on_exit = true;
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Refused, "{stage}");
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::RunCancelled,
            "{stage}"
        );
        assert_eq!(
            receipt.cleanup["simulator"],
            if stage == "before_arm" {
                "kept"
            } else {
                "removed"
            },
            "{stage}"
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{stage}");
        assert_eq!(runner.mock.remaining(), 0, "{stage}");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(
            record.resources.borrowed_ios_stop(),
            if stage == "before_arm" {
                BorrowedIosStop::NotArmed
            } else {
                BorrowedIosStop::Completed
            },
            "{stage}"
        );
        assert!(record.resources.lease.is_none());
    }

    // Failed save when arming pending reverts borrowed_ios_stop before any simulator mutation.
    struct BlockArmSave(MockRunner, PathBuf, usize);
    impl Runner for BlockArmSave {
        fn env_var(&self, name: &str) -> Option<String> {
            self.0.env_var(name)
        }
        fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
            let out = self.0.execute(spec, interruptible);
            if spec.label == "fresh-install-admission" {
                self.2 += 1;
                if self.2 == 2 {
                    std::fs::create_dir(
                        RunRecord::run_dir(&self.1, &run_id())
                            .join(format!(".run.json.tmp.{}", std::process::id())),
                    )
                    .unwrap();
                }
            }
            out
        }
        fn execute_private(
            &mut self,
            spec: &CmdSpec,
            input: &[u8],
            interruptible: bool,
        ) -> qaren::exec::PrivateOutput {
            self.0.execute_private(spec, input, interruptible)
        }
        fn spawn_group_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<Spawned> {
            self.0.spawn_group_unchecked(spec, log)
        }
        fn spawn_piped_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<PipedChild> {
            self.0.spawn_piped_unchecked(spec, log)
        }
        fn sleep(&mut self, d: std::time::Duration) {
            self.0.sleep(d)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.0.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.0.commands_executed()
        }
    }
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_inventory(
        &mut mock,
        &repo,
        "simctl list devices -j",
        &available_inventory("Booted"),
    );
    script_admission(&mut mock);
    common::script_ios_deps(&mut mock);
    script_admission(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    req.restart_device = true;
    req.shutdown_device_on_exit = true;
    let mut runner = BlockArmSave(mock, req.runs_root.clone(), 0);
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::RunRecordUpdateFailed
    );
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!runner.0.calls.iter().any(|c| matches!(
        c.label.as_str(),
        "simctl-shutdown" | "simctl-bootstatus" | "core-walk"
    )));
    assert_eq!(runner.0.remaining(), 0);
    std::fs::remove_dir(
        RunRecord::run_dir(&req.runs_root, &run_id())
            .join(format!(".run.json.tmp.{}", std::process::id())),
    )
    .unwrap();
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(
        record.resources.borrowed_ios_stop(),
        BorrowedIosStop::NotArmed
    );
}

#[test]
fn shutdown_device_on_exit_teardown_faults_retain_pending_stop_and_device_lease() {
    use qaren::runrecord::BorrowedIosStop;
    for fault in [
        "admission_busy",
        "admission_unknown",
        "shutdown_failed",
        "readback_still_booted",
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices -j",
            &available_inventory("Booted"),
        );
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        script_provision_after_deps(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        match fault {
            "admission_busy" | "admission_unknown" => {
                let status = if fault == "admission_busy" {
                    "busy"
                } else {
                    "unknown"
                };
                mock.expect_run(
                    &format!("fresh-install-preflight.js --platform ios --device {UDID}"),
                    CmdOutput {
                        exit_code: Some(4),
                        stdout: serde_json::json!({
                            "v": 1, "platform": "ios", "deviceId": UDID, "status": status
                        })
                        .to_string(),
                        ..Default::default()
                    },
                );
            }
            "shutdown_failed" => {
                script_admission(&mut mock);
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {UDID}"),
                    CmdOutput::failed(1, "shutdown denied"),
                );
            }
            "readback_still_booted" => {
                script_admission(&mut mock);
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
                mock.expect_run(&format!("simctl shutdown {UDID}"), CmdOutput::success(""));
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&available_inventory("Booted")),
                );
            }
            _ => unreachable!(),
        }
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.shutdown_device_on_exit = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{fault}");
        assert!(
            receipt.cleanup["simulator"].starts_with("unresolved:"),
            "{fault}: {}",
            receipt.cleanup["simulator"]
        );
        assert!(
            receipt.cleanup["device_lease"].starts_with("unresolved: retained: simulator"),
            "{fault}: {}",
            receipt.cleanup["device_lease"]
        );
        assert_eq!(mock.remaining(), 0, "{fault}");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(record.phase, Phase::Walking, "{fault}");
        assert_eq!(
            record.resources.borrowed_ios_stop(),
            BorrowedIosStop::Pending,
            "{fault}"
        );
        assert!(
            record.resources.lease.as_ref().unwrap().lock_dir.exists(),
            "{fault}"
        );
    }
}

#[test]
fn closed_stdout_and_dead_leader_do_not_release_an_unproven_core_group() {
    for (inventory, probe_dead_leader) in [
        (CmdOutput::success("1 1 S\n9001 9000 S\n"), true),
        (CmdOutput::failed(1, "ps denied"), false),
        (CmdOutput::success(""), false),
        (CmdOutput::success("not a process table"), false),
        (CmdOutput::success("1 1 S"), false),
        (CmdOutput::success("1 1 Sgarbage\n"), false),
        (CmdOutput::success("1 1 S\n1 1 S\n"), false),
        (
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("1 1 S\n")
            },
            false,
        ),
    ] {
        let (repo, app) = app_repo();
        let req = request(&repo, &app, 30);
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown_core_host(&mut mock, inventory, probe_dead_leader, UDID, None);
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass);
        assert!(receipt.cleanup["core"].starts_with("unresolved"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        assert_eq!(mock.remaining(), 0);
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(record.resources.core.as_ref().unwrap().pgid, 9000);
        assert_eq!(
            record.resources.core_cleanup.unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Unresolved
        );
        let lease = record.resources.lease.unwrap();
        assert!(lease.lock_dir.exists());

        let mut cleanup = MockRunner::new();
        cleanup.expect_run(
            &format!("ps -p {} -o lstart=", std::process::id()),
            CmdOutput::success(""),
        );
        cleanup.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        script_host_probe(&mut cleanup, UDID, hosts_absent());
        let receipt = qaren::commands::cleanup::cleanup(&mut cleanup, &req.runs_root, &run_id());
        assert_eq!(
            receipt.result,
            ReceiptResult::Cleaned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(receipt.cleanup["core"], "absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(cleanup.remaining(), 0);
        assert!(!lease.lock_dir.exists());
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.core.is_none());
        assert_eq!(
            record.resources.core_cleanup.unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Absent
        );
    }
}

const PR_HEAD: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const PR_MOVED: &str = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";

fn pr_view_json(head: &str) -> CmdOutput {
    CmdOutput::success(
        &serde_json::json!({
            "number": 12, "url": "https://github.com/o/r/pull/12", "headRefOid": head,
            "headRefName": "feat/tasks", "isCrossRepository": false,
            "labels": [{"name": "needs-qa"}]
        })
        .to_string(),
    )
}

// Plays git for the PR worktree: add materializes the app at the head (with a block the
// walk saves), remove deletes it. A recorder spawn must find its resource already persisted.
struct PrRunner {
    inner: MockRunner,
    app: PathBuf,
    recorder_persisted_before_spawn: Option<bool>,
    fail_core_spawn: bool,
    planted_worktree_config: Option<String>,
    worktree_config_planted: bool,
}

impl PrRunner {
    fn materialize(&mut self, wt: &Path) {
        let app = wt.join("test-app");
        std::fs::create_dir_all(app.join("node_modules/.bin")).unwrap();
        for file in ["package.json", "pnpm-lock.yaml", "node_modules/.bin/expo"] {
            std::fs::copy(self.app.join(file), app.join(file)).unwrap();
        }
        if self.app.join("App.tsx").is_file() {
            std::fs::copy(self.app.join("App.tsx"), app.join("App.tsx")).unwrap();
        }
        if let Some(yaml) = &self.planted_worktree_config {
            let config = app.join(".qaren");
            std::fs::create_dir_all(&config).unwrap();
            std::fs::write(config.join("config.yaml"), yaml).unwrap();
            self.worktree_config_planted = true;
        }
    }
}

impl Runner for PrRunner {
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.inner.adb_server_version(port)
    }
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        let output = self.inner.execute(spec, interruptible);
        match spec.label.as_str() {
            "adb-pull" if output.ok() => {
                std::fs::write(spec.args.last().unwrap(), "complete recording").unwrap()
            }
            "git-worktree-add" => self.materialize(Path::new(&spec.args[3])),
            "git-worktree-remove" => std::fs::remove_dir_all(&spec.args[3]).unwrap(),
            _ => {}
        }
        output
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.inner.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        if matches!(
            spec.label.as_str(),
            "simctl-record-video" | "adb-screenrecord"
        ) {
            let run_dir = log.parent().unwrap().parent().unwrap();
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            self.recorder_persisted_before_spawn =
                Some(record.resources.recorder.is_some_and(|r| r.pid.is_none()));
        }
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        if spec.label == "core-walk" {
            let app = spec.cwd.as_ref().unwrap();
            if app.join("App.tsx").is_file() {
                std::fs::write(app.join("App.tsx"), "export default changed;\n").unwrap();
            }
        }
        if self.fail_core_spawn && spec.label == "core-walk" {
            self.inner.calls.push(spec.clone());
            return Err(std::io::Error::other("node vanished"));
        }
        if spec.label == "core-walk" {
            let app = spec.cwd.as_ref().unwrap();
            std::fs::create_dir_all(app.join(".qaren/actions")).unwrap();
            std::fs::write(app.join(".qaren/actions/tasks.yaml"),
                "appId: com.rndevagent.testapp\n---\n# id: tasks\n# intent: Sign in\n# appId: com.rndevagent.testapp\n# platform: ios\n\n# 1. Fill password\n- tapOn: { id: login-password }\n- inputText: { input: PASSWORD }\n").unwrap();
        }
        self.inner.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.inner.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.inner.cancellation()
    }
}

// Preflight through the lease for a PR run: the PR worktree comes before provenance and the lease.
fn script_pr_preflight(mock: &mut MockRunner, repo: &Path, wt: &Path) {
    script_pr_preflight_requiring(mock, repo, wt, &[], &[]);
}

fn script_pr_preflight_requiring(
    mock: &mut MockRunner,
    repo: &Path,
    wt: &Path,
    required: &[&str],
    non_secret: &[&str],
) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // invoking checkout
    mock.expect_run("gh pr view", pr_view_json(PR_HEAD));
    mock.expect_run("fetch origin pull/12/head", CmdOutput::success(""));
    mock.expect_run(
        "rev-parse refs/qaren/pr/",
        CmdOutput::success(&format!("{PR_HEAD}\n")),
    );
    mock.expect_run("update-ref -d", CmdOutput::success(""));
    script_plan_requiring(mock, repo, required, non_secret);
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
    mock.expect_run("worktree add --detach", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", wt.display()))); // toplevel of the worktree
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", wt.display()))); // explicit worktree
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
    mock.expect_run("git", CmdOutput::success(""));
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren pr\n"));
    mock.expect_run("lsof", free_port());
}

fn script_pr_provision(mock: &mut MockRunner) {
    common::script_ios_deps(mock);
    script_provision_candidate(mock, "expo run:ios", "", PR_HEAD, "");
}

fn script_pr_provenance_recheck(mock: &mut MockRunner) {
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
    mock.expect_run("git", CmdOutput::success(""));
}

fn script_recorder_start(mock: &mut MockRunner) {
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "Recording started\n",
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("xcrun simctl io\n"));
}

fn script_recorder_stop(mock: &mut MockRunner) {
    mock.expect_run("ps -p 7100", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps -p 7100", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
}

// The check teardown after its drift report: core group, Metro group, hosts.
fn script_pr_teardown_after_drift(mock: &mut MockRunner) {
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    script_host_probe(mock, UDID, hosts_absent());
}

fn pr_pass_stdout() -> String {
    pass_stdout().replace(
        r#""recoveries":0}"#,
        r#""recoveries":0,"blocksWritten":["tasks"]}"#,
    )
}

fn pr_request(repo: &Path, app: &Path) -> RunRequest {
    let mut req = request(repo, app, 30);
    req.pr = Some(qaren::run::PrTarget {
        target: "12".into(),
    });
    req
}

#[test]
fn pr_runs_the_walk_on_a_worktree_at_the_head_with_a_recording_in_order() {
    pr_walk_result(false, false);
}

#[test]
fn pr_without_github_auth_refuses_before_device_or_worktree_admission() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run(
        "gh pr view",
        CmdOutput::failed(1, "authentication required"),
    );
    mock.expect_run("gh auth status", CmdOutput::failed(1, "not logged in"));
    let receipt = run(&mut mock, &pr_request(&repo, &app));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::GithubAuthUnavailable
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(mock.calls.len(), 4);
    assert!(!repo.join("runs").exists());
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn pr_runtime_input_recording_obeys_video_policy_and_secret_inventory() {
    for (policy, non_secret, unused) in [
        (None, false, false),
        (None, true, false),
        (Some("strict"), false, false),
        (Some("strict"), true, false),
        (Some("non-strict"), false, false),
        (Some("non-strict"), true, false),
        (Some("non-strict"), false, true),
        (Some("non-strict"), true, true),
    ] {
        let records = policy == Some("non-strict") && non_secret && !unused;
        let secret = "synthetic\"slot\\value";
        let (repo, app) = app_repo();
        let annotation = if non_secret { " (test-pii)" } else { "" };
        std::fs::write(
            app.join("plan.md"),
            format!("1. Fill \"password\" with input PASSWORD{annotation}\n"),
        )
        .unwrap();
        let mut req = pr_request(&repo, &app);
        if let Some(policy) = policy {
            let yaml = std::fs::read_to_string(&req.config_path).unwrap();
            std::fs::write(&req.config_path, format!("{yaml}video: {policy}\n")).unwrap();
        }
        req.runs_root = repo.join(".qaren/runs");
        let wt = req.runs_root.join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight_requiring(
            mock,
            &repo,
            &wt,
            &["PASSWORD"],
            if non_secret { &["PASSWORD"] } else { &[] },
        );
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        if records {
            mock.expect_spawn_failure("recordVideo", "recorder spawn failure");
        }
        script_host_probe(mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
        script_core_identity(mock);
        script_drift_status(mock);
        mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
        mock.expect_run("git", CmdOutput::success(""));
        script_pr_teardown_after_drift(mock);
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        mock.expect_run(
            "gh pr view https://github.com/o/r/pull/12",
            pr_view_json(PR_HEAD),
        );
        let mut entries = vec![("QAREN_INPUT_PASSWORD".into(), secret.into())];
        if unused {
            entries.push(("QAREN_INPUT_UNUSED".into(), "unused-synthetic".into()));
        }
        let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries(entries));
        let (receipt, events) =
            qaren::redact::with_input_scope(inputs, || run_with_events(&mut runner, &req));
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(runner.inner.remaining(), 0);
        assert_eq!(
            labels(&runner.inner).iter().any(|l| l.contains("record")),
            records
        );
        assert!(receipt.outcomes["video"].starts_with("unavailable("));
        assert_eq!(
            receipt.outcomes["platform_log"],
            "the simulator system log may record displayed field text; see Runtime inputs"
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e["event"] == "stage" && e["payload"]["name"] == "recording")
                .map(|e| e["payload"]["state"].as_str().unwrap())
                .collect::<Vec<_>>(),
            if records {
                vec!["running", "failed"]
            } else {
                vec!["skipped"]
            }
        );
        let escaped = serde_json::to_string(secret).unwrap();
        let escaped = &escaped[1..escaped.len() - 1];
        let preflight = String::from_utf8(runner.inner.private_inputs[1].clone()).unwrap();
        assert!(preflight.contains(escaped));
        assert!(!preflight.contains("unused-synthetic"));
        let core = (0..runner.inner.piped_stdin.len())
            .map(|i| runner.inner.piped_stdin_text(i))
            .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .find(|value| value["payload"].get("plan").is_some())
            .unwrap();
        assert_eq!(
            core["payload"]["inputs"],
            serde_json::json!({"PASSWORD": secret})
        );
        let durable = walk_files(&req.runs_root);
        assert!(!durable.is_empty());
        for (path, bytes) in durable {
            let text = String::from_utf8_lossy(&bytes);
            assert!(
                !text.contains("slot") && !text.contains(escaped),
                "{}",
                path.display()
            );
        }
        assert!(!receipt.to_json().contains("slot"));
    }
}

fn walk_files(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk_files(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            files.push((path, bytes));
        }
    }
    files
}

#[test]
fn recording_start_failures_remain_failed_through_cleanup_and_the_viewer() {
    for retained in [false, true] {
        let (repo, app) = app_repo();
        let mut req = pr_request(&repo, &app);
        req.runs_root = repo.join(".qaren/runs");
        let wt = req.runs_root.join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        if retained {
            mock.expect_spawn(
                "recordVideo",
                Spawned {
                    pid: 7100,
                    pgid: 7100,
                },
            );
            mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
            mock.expect_run("ps", CmdOutput::success("xcrun simctl io\n"));
            mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
            mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
            mock.expect_run("ps -A", CmdOutput::failed(1, "inventory unavailable"));
        } else {
            mock.expect_spawn_failure("recordVideo", "recorder spawn failure");
        }
        script_host_probe(mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
        script_core_identity(mock);
        script_drift_status(mock);
        mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
        mock.expect_run("git", CmdOutput::success(""));
        if retained {
            mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
            mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        }
        script_pr_teardown_after_drift(mock);
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        mock.expect_run(
            "gh pr view https://github.com/o/r/pull/12",
            pr_view_json(PR_HEAD),
        );
        let (receipt, events) = run_with_events(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert!(receipt.outcomes["video"].starts_with("unavailable("));
        assert_eq!(runner.inner.remaining(), 0);
        assert_eq!(runner.recorder_persisted_before_spawn, Some(true));
        if retained {
            assert_eq!(receipt.cleanup["recorder"], "removed");
        }
        assert_eq!(
            events
                .iter()
                .filter(|e| e["event"] == "stage" && e["payload"]["name"] == "recording")
                .map(|e| e["payload"]["state"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["running", "failed"]
        );
        for format in ["--plain", "--json"] {
            let output = std::process::Command::new(env!("CARGO_BIN_EXE_qaren"))
                .env("HOME", &repo)
                .args(["watch", &receipt.run_id, format])
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            let text = String::from_utf8(output.stdout).unwrap();
            if format == "--json" {
                let state: serde_json::Value = serde_json::from_str(&text).unwrap();
                let recording = state["stages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["name"] == "recording")
                    .unwrap();
                assert_eq!(recording["state"], "failed");
                assert_eq!(state["end"]["result"], "pass");
            } else {
                let recording: Vec<_> = text.lines().filter(|l| l.contains("Recording")).collect();
                assert_eq!(recording.len(), 1);
                assert!(recording[0].starts_with('✗'));
                assert!(!recording[0].contains("not needed"));
            }
        }
    }
}

#[test]
fn candidate_drift_during_a_pr_walk_fails_and_withholds_publication() {
    pr_walk_result(true, false);
}

#[test]
fn cancelled_pr_walks_with_or_without_source_drift_cannot_publish() {
    for source_drift in [false, true] {
        let (repo, app) = app_repo();
        if source_drift {
            std::fs::write(app.join("App.tsx"), "export default original;\n").unwrap();
        }
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        script_recorder_start(mock);
        let one_row = format!("{}\n", envelope(2, "row", &row(1, "step")));
        script_host_probe(mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
        script_core_identity(mock);
        mock.cancel_after = Some(("-p 9000".into(), "received SIGTERM".into()));
        script_recorder_stop(mock);
        script_teardown_resources(
            mock,
            CmdOutput::success("1 1 S\n6000 6000 S\n"),
            false,
            UDID,
            Some(hosts_absent()),
        );
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));

        let receipt = run(&mut runner, &pr_request(&repo, &app));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
        assert_eq!(runner.inner.remaining(), 0);
        let runs = repo.join("runs");
        let record = RunRecord::load(&runs, &run_id()).unwrap();
        assert_eq!(record.failure.unwrap().code, FailureCode::RunCancelled);
        let dir = runs.join(run_id());
        assert!(!dir.join("pr.json").exists());
        let mut publisher = qaren::exec::MockRunner::new();
        let published = qaren::publish::publish(
            &mut publisher,
            &runs,
            &run_id(),
            &qaren::redact::MachineIdentity::default(),
        );
        assert_eq!(published.result, ReceiptResult::Refused);
        assert_eq!(published.failure.unwrap().code, FailureCode::RunCancelled);
        assert!(publisher.calls.is_empty());
        assert!(!dir.join("publication.json").exists());
    }
}

#[test]
fn pr_run_retries_an_occupied_timestamp_without_changing_the_existing_run() {
    pr_walk_result(false, true);
}

fn pr_walk_result(candidate_drift: bool, collision: bool) {
    let (repo, app) = app_repo();
    if candidate_drift {
        std::fs::write(app.join("App.tsx"), "export default original;\n").unwrap();
    }
    let id = if collision {
        let occupied = repo.join("runs").join(run_id());
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(occupied.join("canary"), "existing run").unwrap();
        format!("{}-000001", run_id())
    } else {
        run_id()
    };
    let wt = repo.join("runs").join(&id).join("wt");
    let mut runner = PrRunner {
        inner: MockRunner::new(),
        app: app.clone(),
        recorder_persisted_before_spawn: None,
        fail_core_spawn: false,
        planted_worktree_config: None,
        worktree_config_planted: false,
    };
    let mock = &mut runner.inner;
    script_pr_preflight(mock, &repo, &wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &pr_pass_stdout().replace(&run_id(), &id),
        Some(0),
    );
    script_core_identity(mock);
    script_drift_status(mock);
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n"))); // drift report
    mock.expect_run(
        "git",
        CmdOutput::success(if candidate_drift {
            " M test-app/App.tsx\0?? test-app/.qaren/actions/tasks.yaml\0"
        } else {
            "?? test-app/.qaren/actions/tasks.yaml\0"
        }),
    );
    script_recorder_stop(mock);
    script_pr_teardown_after_drift(mock);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
    mock.expect_run(
        "gh pr view https://github.com/o/r/pull/12",
        pr_view_json(PR_MOVED),
    );

    let receipt = run(&mut runner, &pr_request(&repo, &app));

    assert_eq!(receipt.hints.len(), 1);
    assert_eq!(receipt.hints[0].code, "LOGIN_BLOCK_RUN_ONLY");
    assert!(receipt.hints[0]
        .text
        .contains("saved only to this PR run's evidence"));
    assert!(receipt.hints[0]
        .text
        .contains("save it with `qaren check` in the main copy"));
    assert!(!receipt.hints[0].text.contains("loginBlock:"));
    assert!(!receipt.hints[0].text.contains("loginMarker:"));
    if candidate_drift {
        assert_eq!(receipt.result, ReceiptResult::Fail);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::CandidateDrifted
        );
        assert_eq!(receipt.ledger.as_ref().unwrap().verdict, "FAIL");
        let terminal = RunRecord::load(&repo.join("runs"), &id)
            .unwrap()
            .terminal
            .unwrap();
        assert!(!terminal.final_verification.matched);
        assert!(!terminal.cancelled);
        let mut publisher = qaren::exec::MockRunner::new();
        let published = qaren::publish::publish(
            &mut publisher,
            &repo.join("runs"),
            &id,
            &qaren::redact::MachineIdentity::default(),
        );
        assert_eq!(published.result, ReceiptResult::Failed);
        assert_eq!(
            published.failure.unwrap().code,
            FailureCode::CandidateDrifted
        );
        assert!(publisher.calls.is_empty());
    } else {
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    }
    assert_eq!(receipt.verb, "pr");
    assert_eq!(runner.inner.remaining(), 0);
    assert_eq!(runner.recorder_persisted_before_spawn, Some(true));
    assert_subsequence(
        &labels(&runner.inner),
        &[
            "gh-pr-view",
            "git-fetch-pr",
            "git-fetch-head",
            "git-worktree-add",
            "git-head",
            "git-dirty",
            "ps-lstart",
            "lsof-port",
            "pnpm-install",
            "expo-run-ios",
            "git-head",
            "simctl-record-video",
            "core-walk",
            "recorder-interrupt",
            "kill-group",
            "git-worktree-remove",
            "gh-pr-view",
        ],
    );
    let core = runner
        .inner
        .calls
        .iter()
        .find(|c| c.label == "core-walk")
        .unwrap();
    assert_eq!(core.cwd.as_deref(), Some(wt.join("test-app").as_path()));
    assert_eq!(receipt.tested_older_commit.as_deref(), Some(PR_HEAD));
    assert_eq!(receipt.outcomes["video"], "unavailable(ffmpeg)");
    assert!(!receipt.outcomes.contains_key("platform_log"));
    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert_eq!(
        receipt.cleanup["pr_worktree"],
        "removed (reclaimed 4096 bytes)"
    );
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!wt.exists());
    let run_dir = repo.join("runs").join(&id);
    assert!(std::fs::read_to_string(run_dir.join("blocks/tasks.yaml"))
        .unwrap()
        .contains("- inputText: { input: PASSWORD }"));
    let pr: qaren::publish::PrRunRecord =
        serde_json::from_slice(&std::fs::read(run_dir.join("pr.json")).unwrap()).unwrap();
    assert_eq!(
        pr.video_publication,
        qaren::record::VideoPublication::Unknown
    );
    assert_eq!(
        pr.video_withholding_reason.as_deref(),
        Some("video publication eligibility is missing or unknown")
    );
    assert_eq!(pr.head_ref_oid, PR_HEAD);
    assert_eq!(pr.head_ref_name, "feat/tasks");
    assert!(pr.tested_older_commit);
    assert_eq!(pr.app_rel, "test-app");
    assert_eq!(pr.blocks, ["tasks"]);
    let record = RunRecord::load(&repo.join("runs"), &id).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.recorder.is_none());
    assert!(record.resources.pr_worktree.is_none());
    if collision {
        assert_eq!(
            std::fs::read_to_string(repo.join("runs").join(run_id()).join("canary")).unwrap(),
            "existing run"
        );
    }
}

#[test]
fn a_core_failure_on_a_pr_run_still_stops_the_recorder_and_removes_the_worktree() {
    let (repo, app) = app_repo();
    let wt = repo.join("runs").join(run_id()).join("wt");
    let mut runner = PrRunner {
        inner: MockRunner::new(),
        app: app.clone(),
        recorder_persisted_before_spawn: None,
        fail_core_spawn: true,
        planted_worktree_config: None,
        worktree_config_planted: false,
    };
    let mock = &mut runner.inner;
    script_pr_preflight(mock, &repo, &wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    // teardown: Metro group, hosts, then the recorder before the lease, then the worktree.
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    script_recorder_stop(mock);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));

    let receipt = run(&mut runner, &pr_request(&repo, &app));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{:?}",
        receipt.failure
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CoreSpawnFailed
    );
    assert_eq!(runner.inner.remaining(), 0);
    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert_eq!(
        receipt.cleanup["pr_worktree"],
        "removed (reclaimed 4096 bytes)"
    );
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!wt.exists());
}

#[test]
fn a_pr_run_retains_its_worktree_when_metro_cleanup_is_unproven() {
    let (repo, app) = app_repo();
    let wt = repo.join("runs").join(run_id()).join("wt");
    let mut runner = PrRunner {
        inner: MockRunner::new(),
        app: app.clone(),
        recorder_persisted_before_spawn: None,
        fail_core_spawn: true,
        planted_worktree_config: None,
        worktree_config_planted: false,
    };
    let mock = &mut runner.inner;
    script_pr_preflight(mock, &repo, &wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", CmdOutput::failed(2, "inventory unavailable"));
    script_recorder_stop(mock);

    let receipt = run(&mut runner, &pr_request(&repo, &app));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{:?}",
        receipt.failure
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CoreSpawnFailed
    );
    assert_eq!(runner.inner.remaining(), 0);
    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert!(receipt.cleanup["pr_worktree"].contains("retained"));
    assert!(receipt.cleanup["device_lease"].contains("retained"));
    assert!(wt.exists());
    assert!(RunRecord::load(&repo.join("runs"), &run_id())
        .unwrap()
        .resources
        .pr_worktree
        .is_some());
}

#[test]
fn a_pr_run_keeps_the_unbound_metros_surviving_child_worktree() {
    let (repo, app) = app_repo();
    let wt = repo.join("runs").join(run_id()).join("wt");
    let mut runner = PrRunner {
        inner: MockRunner::new(),
        app: app.clone(),
        recorder_persisted_before_spawn: None,
        fail_core_spawn: true,
        planted_worktree_config: None,
        worktree_config_planted: false,
    };
    let mock = &mut runner.inner;
    script_pr_preflight(mock, &repo, &wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6001 6000 S\n"));
    script_recorder_stop(mock);

    let receipt = run(&mut runner, &pr_request(&repo, &app));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{:?}",
        receipt.failure
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CoreSpawnFailed
    );
    assert_eq!(runner.inner.remaining(), 0);
    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert!(receipt.cleanup["pr_worktree"].contains("retained"));
    assert!(receipt.cleanup["device_lease"].contains("retained"));
    assert!(wt.exists());
    assert!(RunRecord::load(&repo.join("runs"), &run_id())
        .unwrap()
        .resources
        .pr_worktree
        .is_some());
}

#[test]
fn a_fetched_head_that_is_not_the_viewed_head_refuses_and_leaves_no_worktree() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("gh pr view", pr_view_json(PR_HEAD));
    mock.expect_run("fetch origin pull/12/head", CmdOutput::success(""));
    mock.expect_run(
        "rev-parse refs/qaren/pr/",
        CmdOutput::success(&format!("{PR_MOVED}\n")),
    );
    mock.expect_run("update-ref -d", CmdOutput::success(""));

    let receipt = run(&mut mock, &pr_request(&repo, &app));

    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::PrWorktreeFailed
    );
    assert_eq!(receipt.verb, "pr");
    assert_eq!(receipt.run_id, "none");
    assert!(!receipt.cleanup.contains_key("pr_worktree"));
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).contains(&"git-worktree-add".to_string()));
    assert!(!labels(&mock).iter().any(|l| l == "simctl-list-booted"));
}

#[test]
fn pr_receipt_reports_the_final_recorder_cleanup_retry() {
    for retry_succeeds in [true, false] {
        let (repo, app) = app_repo();
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        script_recorder_start(mock);
        script_host_probe(mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
        script_core_identity(mock);
        script_drift_status(mock);
        mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
        mock.expect_run("git", CmdOutput::success(""));
        mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
        mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
        mock.expect_run("ps -A", CmdOutput::failed(1, "inventory unavailable"));
        script_pr_teardown_after_drift(mock);
        mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
        mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
        if retry_succeeds {
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        } else {
            mock.expect_run("ps -A", CmdOutput::success("7101 7100 S\n"));
            mock.expect_run("ps -p 7100", CmdOutput::failed(1, ""));
            mock.expect_run("ps -A", CmdOutput::success("7101 7100 S\n"));
        }
        if retry_succeeds {
            mock.expect_run("du -sk", CmdOutput::success("4\n"));
            mock.expect_run("worktree remove --force", CmdOutput::success(""));
        }
        mock.expect_run(
            "gh pr view https://github.com/o/r/pull/12",
            pr_view_json(PR_HEAD),
        );

        let receipt = run(&mut runner, &pr_request(&repo, &app));

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(runner.inner.remaining(), 0);
        let saved = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
        assert_eq!(
            saved.terminal.as_ref().unwrap().ownership_proven,
            retry_succeeds
        );
        if !retry_succeeds {
            assert!(saved
                .terminal
                .as_ref()
                .unwrap()
                .publication_refusal()
                .is_some());
            assert!(saved.resources.pr_worktree.is_some());
        }
        if retry_succeeds {
            assert_eq!(receipt.cleanup["recorder"], "removed");
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(saved.phase, Phase::Cleaned);
            assert!(saved.resources.recorder.is_none());
            assert!(saved.resources.lease.is_none());
        } else {
            assert_eq!(
                receipt.cleanup["recorder"],
                "unresolved: process group remains but its leader ownership is unproven"
            );
            assert_eq!(saved.phase, Phase::Walking);
            assert!(saved.resources.recorder.is_some());
            assert!(saved.resources.lease.is_some());
            assert_eq!(
                receipt.next_action,
                format!("qaren cleanup {} --json", run_id())
            );
        }
    }
}

#[test]
fn cancellation_during_successful_dependency_install_skips_fresh_reset_and_cleans_up() {
    let (repo, app) = app_repo();
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    mock.expect_run(
        "pnpm install --frozen-lockfile",
        CmdOutput::success("installed"),
    );
    mock.cancel_after = Some(("pnpm install".into(), "received SIGTERM".into()));
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunCancelled
    );
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(mock.calls.iter().any(|c| c.label == "pnpm-install"));
    assert!(!mock.calls.iter().any(|c| c.label == "simctl-uninstall"));
    assert!(mock.spawned_logs.is_empty());
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(record.resources.fresh_install.is_none());
    assert!(record.resources.lease.is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn cancelled_pr_startup_never_dispatches_the_core_and_cleans_up() {
    for recorder_started in [false, true] {
        let (repo, app) = app_repo();
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        if recorder_started {
            script_drift_status(mock);
            script_recorder_start(mock);
            mock.cancel_after = Some(("-p 7100 -o command=".into(), "received SIGTERM".into()));
            script_recorder_stop(mock);
        } else {
            mock.expect_run(
                "(exclude).qaren/actions",
                CmdOutput::failed(1, "interrupted"),
            );
            mock.cancel_after = Some(("(exclude).qaren/actions".into(), "received SIGTERM".into()));
        }
        script_metro_teardown(mock, UDID, None);
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        let receipt = run(&mut runner, &pr_request(&repo, &app));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::RunCancelled
        );
        assert_eq!(receipt.cleanup["metro"], "removed");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!runner.inner.calls.iter().any(|c| c.label == "core-walk"));
        assert_eq!(
            runner.recorder_persisted_before_spawn,
            recorder_started.then_some(true)
        );
        assert!(!wt.exists());
        assert_eq!(runner.inner.remaining(), 0);
    }
}

#[test]
fn login_keys_reach_the_core() {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/Native App.xcworkspace");
    configure_workspace(&app, "ios/Native App.xcworkspace", "Native Debug");
    let config = app.join(".qaren/config.yaml");
    let mut yaml = std::fs::read_to_string(&config).unwrap();
    yaml.push_str("loginBlock: log-in\nloginMarker:\n  id: login-screen\n");
    std::fs::write(&config, yaml).unwrap();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_provision_build(&mut mock, "xcodebuild", common::IOS_NATIVE_FILES);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let request = (0..mock.piped_stdin.len())
        .map(|i| mock.piped_stdin_text(i))
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .find(|value| value["payload"].get("plan").is_some())
        .unwrap();
    assert_eq!(request["payload"]["loginBlock"], "log-in");
    assert_eq!(
        request["payload"]["loginSnapshot"],
        serde_json::json!({"slug": "log-in", "content": null})
    );
    assert_eq!(request["payload"]["inputProtocol"], 1);
    assert_eq!(request["payload"]["inputs"], serde_json::json!({}));
    assert_eq!(
        request["payload"]["loginMarker"],
        serde_json::json!({"id": "login-screen"})
    );
}

// R2: a cancel caught after the walk (video finalization, teardown) still decides the one terminal result.
#[test]
fn a_late_cancellation_is_the_terminal_result_and_publication_refuses() {
    for (late_hint, ffmpeg_probed) in [("which ffmpeg", true), ("/bin/kill", false)] {
        let (repo, app) = app_repo();
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        };
        let mock = &mut runner.inner;
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        script_recorder_start(mock);
        script_host_probe(mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
        script_core_identity(mock);
        script_drift_status(mock);
        mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
        mock.expect_run(
            "git",
            CmdOutput::success("?? test-app/.qaren/actions/tasks.yaml\0"),
        );
        script_recorder_stop(mock);
        script_pr_teardown_after_drift(mock);
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        if ffmpeg_probed {
            mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
        }
        mock.cancel_after = Some((late_hint.into(), "received SIGTERM".into()));

        let receipt = run(&mut runner, &pr_request(&repo, &app));

        assert_eq!(receipt.result, ReceiptResult::Refused, "{late_hint}");
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
        assert_eq!(runner.inner.remaining(), 0, "{late_hint}");
        assert_eq!(
            labels(&runner.inner)
                .iter()
                .filter(|label| label.as_str() == "gh-pr-view")
                .count(),
            1,
            "no forward forge call after the cancel"
        );
        let runs = repo.join("runs");
        let record = RunRecord::load(&runs, &run_id()).unwrap();
        let terminal = record.terminal.expect("the terminal result is persisted");
        assert!(terminal.cancelled, "{late_hint}");
        assert_eq!(terminal.verdict, "PASS");
        assert!(terminal.final_verification.matched);
        assert_eq!(terminal.final_verification.tested, PR_HEAD);
        assert_eq!(record.failure.unwrap().code, FailureCode::RunCancelled);
        let mut publisher = qaren::exec::MockRunner::new();
        let published = qaren::publish::publish(
            &mut publisher,
            &runs,
            &run_id(),
            &qaren::redact::MachineIdentity::default(),
        );
        assert_eq!(published.failure.unwrap().code, FailureCode::RunCancelled);
        assert!(publisher.calls.is_empty());
    }
}

// R1: a cancel caught at a pre-walk forward-effect boundary stops that effect and every later one.
#[test]
fn a_cancel_at_each_pre_walk_effect_boundary_runs_nothing_after_it_and_never_resets_the_app() {
    for hint in [
        "fresh-install-preflight.js",
        "pnpm install",
        "expo run:ios --help",
        "simctl bootstatus",
        "plutil -convert json",
        "simctl uninstall",
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight_inventory(
            &mut mock,
            &repo,
            "simctl list devices -j",
            &available_inventory("Shutdown"),
        );
        script_admission(&mut mock);
        common::script_ios_deps(&mut mock);
        script_admission(&mut mock);
        mock.expect_run(
            &format!("simctl bootstatus {UDID} -b"),
            CmdOutput::success(""),
        );
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&available_inventory("Booted")),
        );
        script_app_presence(&mut mock, true);
        mock.expect_run(
            &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
            CmdOutput::success(""),
        );
        script_app_presence(&mut mock, false);
        mock.cancel_after = Some((hint.into(), "received SIGTERM".into()));
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.boot_device = true;
        req.fresh_install = true;

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{hint}");
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
        let last = mock.calls.last().unwrap().rendered();
        assert!(last.contains(hint), "{hint}: the last effect was {last:?}");
        let uninstalled = labels(&mock).iter().any(|l| l == "simctl-uninstall");
        assert_eq!(uninstalled, hint == "simctl uninstall", "{hint}");
        assert!(!labels(&mock)
            .iter()
            .any(|l| l == "expo-run-ios" || l == "core-walk"));
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{hint}");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.fresh_install.is_none(), "{hint}");
    }
}

// QA scenario: a cancel during the pre-record Git probes leaves no run, lease or forward effect.
#[test]
fn a_cancel_during_the_git_probes_claims_nothing_and_runs_nothing_after_it() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
    mock.expect_run(
        "rev-parse --show-toplevel",
        CmdOutput::failed(1, "interrupted"),
    );
    mock.cancel_after = Some((
        "rev-parse --show-toplevel".into(),
        "received SIGTERM".into(),
    ));
    let req = request(&repo, &app, 30);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
    assert_eq!(receipt.run_id, "none");
    assert_eq!(mock.remaining(), 0);
    assert!(mock
        .calls
        .last()
        .unwrap()
        .rendered()
        .contains("rev-parse --show-toplevel"));
    assert!(!req.lock_root.exists());
    assert!(!req.runs_root.exists());
}

// Writes the recorder's raw capture and each encode's output, as the real tools would.
struct Encoding(PrRunner);

impl Runner for Encoding {
    fn env_var(&self, name: &str) -> Option<String> {
        self.0.env_var(name)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.0.execute_private(spec, input, interruptible)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "ffmpeg-encode" {
            std::fs::write(spec.args.last().unwrap(), vec![0u8; 64]).unwrap();
        }
        self.0.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        if spec.label == "simctl-record-video" {
            let raw = PathBuf::from(spec.args.last().unwrap());
            std::fs::write(&raw, vec![0u8; 4096]).unwrap();
            let other = raw
                .ancestors()
                .nth(3)
                .unwrap()
                .join("check-other/media/raw.mov");
            std::fs::create_dir_all(other.parent().unwrap()).unwrap();
            std::fs::write(other, b"foreign").unwrap();
        }
        self.0.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        self.0.cancellation()
    }
}

// R8: only this run's own raw capture is reclaimed, and only once a playable encode replaces it.
#[test]
fn a_playable_encode_reclaims_the_runs_raw_capture_and_reports_the_bytes() {
    for encodes in [true, false] {
        let (repo, app) = app_repo();
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = Encoding(PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        });
        let mock = &mut runner.0.inner;
        let admitted = mock.now_epoch_ms() + 4_100;
        if encodes {
            // PR1142's recorder start delay (t0 - recording_from).
            mock.advance_on = Some(("ps -p 7100".into(), 559));
        }
        script_pr_preflight(mock, &repo, &wt);
        script_pr_provision(mock);
        script_pr_provenance_recheck(mock);
        script_drift_status(mock);
        script_recorder_start(mock);
        script_host_probe(mock, UDID, hosts_absent());
        let stdout = pr_pass_stdout()
            .replace(
                "\"recoveries\":0",
                &format!("\"recoveries\":0,\"admittedAtMs\":{admitted}"),
            )
            .replace("\"t\":200", "\"t\":33526");
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        script_core_identity(mock);
        script_drift_status(mock);
        mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
        mock.expect_run(
            "git",
            CmdOutput::success("?? test-app/.qaren/actions/tasks.yaml\0"),
        );
        script_recorder_stop(mock);
        script_pr_teardown_after_drift(mock);
        mock.expect_run("du -sk", CmdOutput::success("4\n"));
        mock.expect_run("worktree remove --force", CmdOutput::success(""));
        mock.expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        if encodes {
            mock.expect_run("ffmpeg", CmdOutput::success(""));
            mock.expect_run("ffprobe", CmdOutput::success("3.5\n"));
            mock.expect_run("ffmpeg", CmdOutput::success(""));
            mock.expect_run("ffprobe", CmdOutput::success("0.1\n"));
        } else {
            mock.expect_run("ffmpeg", CmdOutput::failed(1, "encode failed"));
        }
        mock.expect_run(
            "gh pr view https://github.com/o/r/pull/12",
            pr_view_json(PR_HEAD),
        );
        let other = repo.join("runs/check-other/media/raw.mov");

        let receipt = run(&mut runner, &pr_request(&repo, &app));

        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(runner.0.inner.remaining(), 0);
        let media = repo.join("runs").join(run_id()).join("media");
        assert_eq!(
            !media.join("raw.mov").exists(),
            encodes,
            "encodes={encodes}"
        );
        assert!(other.exists(), "another run's capture is never touched");
        if encodes {
            assert!(media.join("video.mp4").is_file());
            assert!(media.join("video-published.mp4").is_file());
            let args = &runner
                .0
                .inner
                .calls
                .iter()
                .filter(|c| c.label == "ffmpeg-encode")
                .nth(1)
                .unwrap()
                .args;
            let ms = |flag: &str| {
                let at = args.iter().position(|a| a == flag).unwrap();
                (args[at + 1].parse::<f64>().unwrap() * 1000.0).round() as u64
            };
            // The cut lands at full-video max(row.t), never rebased past the recorder start delay into teardown.
            assert_eq!(ms("-ss") + ms("-t"), 33_526);
            assert_eq!(receipt.outcomes["reclaimed"], "media/raw.mov: 4096 bytes");
        } else {
            assert!(!receipt.outcomes.contains_key("reclaimed"));
        }
    }
}

struct CancelAfterTerminalSave(PrRunner, PathBuf);

impl Runner for CancelAfterTerminalSave {
    fn env_var(&self, name: &str) -> Option<String> {
        self.0.env_var(name)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.0.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.0.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
    fn cancellation(&self) -> Option<String> {
        if RunRecord::load(&self.1, &run_id())
            .ok()
            .is_some_and(|record| record.terminal.is_some())
        {
            Some("received SIGTERM".into())
        } else {
            self.0.cancellation()
        }
    }
}

#[test]
fn cancellation_during_terminal_save_withholds_the_publish_handoff() {
    let (repo, app) = app_repo();
    let wt = repo.join("runs").join(run_id()).join("wt");
    let mut runner = CancelAfterTerminalSave(
        PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: None,
            worktree_config_planted: false,
        },
        repo.join("runs"),
    );
    let mock = &mut runner.0.inner;
    script_pr_preflight(mock, &repo, &wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
    script_core_identity(mock);
    script_drift_status(mock);
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/actions/tasks.yaml\0"),
    );
    script_recorder_stop(mock);
    script_pr_teardown_after_drift(mock);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
    mock.expect_run("gh", pr_view_json(PR_HEAD));

    let receipt = run(&mut runner, &pr_request(&repo, &app));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
    assert_eq!(runner.0.inner.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert!(record.terminal.unwrap().cancelled);
    assert_eq!(record.failure.unwrap().code, FailureCode::RunCancelled);
    assert!(!repo.join("runs").join(run_id()).join("pr.json").exists());
    assert!(!repo.join("runs").join(run_id()).join("plan.md").exists());
    let mut publisher = qaren::exec::MockRunner::new();
    let receipt = qaren::publish::publish(
        &mut publisher,
        &repo.join("runs"),
        &run_id(),
        &qaren::redact::MachineIdentity::default(),
    );
    assert_eq!(receipt.failure.unwrap().code, FailureCode::RunCancelled);
    assert!(publisher.calls.is_empty());
}

#[test]
fn a_walk_without_a_result_never_renders_plan_text_into_durable_sinks() {
    let (repo, app) = app_repo();
    std::fs::write(
        app.join("plan.md"),
        "1. Fill \"pin\" with \"hunter-canary-77\"\n✓ \"Tasks\"\n",
    )
    .unwrap();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    let one_row = format!(
        "{}\n{}\n",
        envelope(2, "admitted", "{}"),
        envelope(3, "row", &row(1, "step"))
    );
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 5));

    assert_eq!(receipt.result, ReceiptResult::Fail);
    let run_dir = repo.join("runs").join(run_id());
    let report = std::fs::read_to_string(run_dir.join("report.md")).unwrap();
    let ledger = std::fs::read_to_string(run_dir.join("ledger.json")).unwrap();
    for sink in [&report, &ledger, &receipt.to_json()] {
        assert!(!sink.contains("hunter-canary-77"), "{sink}");
        assert!(!sink.contains("Fill \\\"pin\\\""), "{sink}");
    }
    assert!(
        report.contains("- ✗ line 1\n") || report.contains("- ✓ line 1\n"),
        "{report}"
    );
}

#[test]
fn every_build_decision_reports_fingerprint_completeness_and_reuse_reports_ready_timing() {
    use qaren::buildplan::{self, BuildDecision};
    const CANARY: &str = "qaren-canary-7f3a91";
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/First.xcworkspace");
    configure_workspace(&app, "ios/First.xcworkspace", "Debug");
    let incomplete_files = format!("{}test-app/app.json\0", common::IOS_NATIVE_FILES);
    for (index, case) in ["no-cache", "warm", "old-schema", "incomplete"]
        .into_iter()
        .enumerate()
    {
        let state_path = buildplan::state_path(&repo, "ios", "com.rndevagent.testapp");
        if case == "old-schema" {
            let mut old: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
            old["schema"] = "qaren-native-cache/1".into();
            std::fs::write(&state_path, old.to_string()).unwrap();
        }
        if case == "incomplete" {
            std::fs::write(
                app.join("app.json"),
                format!("{{\"expo\":{{\"icon\":\"./{CANARY}.png\"}}}}"),
            )
            .unwrap();
        }
        let files = match case {
            "incomplete" => incomplete_files.as_str(),
            _ => common::IOS_NATIVE_FILES,
        };
        // An unreadable worktree state no longer blocks the verified machine-store build.
        let reuse = matches!(case, "warm" | "old-schema");
        let mut req = request(&repo, &app, 30);
        req.runs_root = repo.join(format!("runs-{index}"));
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        if reuse {
            mock.expect_run("ls-files", CmdOutput::success(files));
            common::script_xcode(&mut mock);
            script_warm_launch_after_one_metro_retry(&mut mock);
            script_ready_recheck(&mut mock, files);
        } else {
            script_provision_build(&mut mock, "xcodebuild", files);
        }
        script_drift_status(&mut mock);
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);

        let (receipt, events) = run_with_events(&mut mock, &req);

        assert_eq!(
            receipt.result,
            ReceiptResult::Pass,
            "{case}: {:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0, "{case}");
        let decision = serde_json::to_value(receipt.build.as_ref().unwrap().decision).unwrap();
        let decision = decision.as_str().unwrap();
        let build: &[&str] = match decision {
            "reuse" => &["prebuild skipped", "native_build skipped"],
            "clean" => &[
                "prebuild running",
                "prebuild passed",
                "native_build running",
                "native_build passed",
            ],
            _ => &[
                "prebuild skipped",
                "native_build running",
                "native_build passed",
            ],
        };
        let mut expected = vec![
            "preflight running".to_string(),
            "preflight passed".into(),
            "deps running".into(),
            "deps passed".into(),
            "build_decision running".into(),
            format!("build_decision passed {decision}"),
        ];
        expected.extend(build.iter().map(|s| s.to_string()));
        expected.extend(
            [
                "install_launch_ready running",
                "install_cached running",
                "install_cached passed",
                "metro_ready running",
                "metro_ready passed",
                "dev_client_manifest running",
                "dev_client_manifest passed",
                "dev_menu_defaults running",
                "dev_menu_defaults passed",
                "app_launch running",
                "app_launch passed",
                "ready_probes running",
                "ready_probes passed",
                "install_launch_ready passed",
                "verify running",
                "verify passed",
                "recording skipped",
                "attach running",
                "attach passed",
                "steps running",
                "steps passed",
                "cleanup running",
                "cleanup passed",
            ]
            .map(String::from),
        );
        assert_eq!(stage_trail(&events), expected, "{case}");
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| e["event"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"run") && kinds.contains(&"admitted") && kinds.contains(&"coreT0"),
            "{case}: {kinds:?}"
        );
        assert!(kinds.contains(&"row"), "{case}");
        assert_eq!(*kinds.last().unwrap(), "end");
        assert_eq!(events.last().unwrap()["payload"]["result"], "pass");
        assert_eq!(events.last().unwrap()["payload"]["droppedEvents"], 0);
        for (i, e) in events.iter().enumerate() {
            assert_eq!(e["seq"], i as u64 + 1, "{case}");
        }
        assert_eq!(
            receipt.build.as_ref().unwrap().decision == BuildDecision::Reuse,
            reuse,
            "{case}"
        );
        let complete = if case == "incomplete" {
            "false"
        } else {
            "true"
        };
        assert_eq!(
            receipt
                .outcomes
                .get("fingerprint_complete")
                .map(String::as_str),
            Some(complete),
            "{case}: {:?}",
            receipt.outcomes
        );
        assert!(receipt.outcomes.contains_key("fingerprint_parts"), "{case}");
        let timing = |key: &str| {
            *receipt
                .timings_ms
                .get(key)
                .unwrap_or_else(|| panic!("{case}: no {key} timing"))
        };
        if reuse {
            let span: u64 = [
                "install_cached",
                "metro_ready",
                "app_launch",
                "ready_probes",
            ]
            .into_iter()
            .map(timing)
            .sum();
            assert_eq!(
                timing("build_and_ready"),
                span,
                "{case}: {:?}",
                receipt.timings_ms
            );
            assert!(
                span > 0,
                "{case}: the mock clock must advance through readiness"
            );
        } else {
            timing("build_and_ready");
        }
        let outcomes = serde_json::to_string(&receipt.outcomes).unwrap();
        assert!(!outcomes.contains(CANARY), "{case}: {outcomes}");
    }
}

#[test]
fn a_cancel_during_a_cached_ios_install_names_the_substage() {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/First.xcworkspace");
    configure_workspace(&app, "ios/First.xcworkspace", "Debug");
    let files = common::IOS_NATIVE_FILES;
    let mut seed = MockRunner::new();
    script_preflight(&mut seed, &repo);
    seed.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_provision_build(&mut seed, "xcodebuild", files);
    script_drift_status(&mut seed);
    script_host_probe(&mut seed, UDID, hosts_absent());
    seed.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut seed);
    script_teardown(&mut seed);
    let mut req = request(&repo, &app, 30);
    req.runs_root = repo.join("runs-seed");
    assert_eq!(run(&mut seed, &req).result, ReceiptResult::Pass);

    let cases = [
        ("simctl install", "install_cached"),
        ("expo-platform", "dev_client_manifest"),
        ("defaults write", "dev_menu_defaults"),
        ("simctl launch", "app_launch"),
    ];
    for (index, (hint, substage)) in cases.into_iter().enumerate() {
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(files));
        common::script_xcode(&mut mock);
        common::script_ios_app_verification(&mut mock);
        common::script_ios_metro_spawn(&mut mock);
        mock.expect_run("simctl install", CmdOutput::success(""));
        if index > 0 {
            mock.expect_run("ps", CmdOutput::success(LSTART));
            mock.expect_run("ps", CmdOutput::success("S"));
            mock.expect_run("lsof", CmdOutput::success("6001"));
            mock.expect_run("ps", CmdOutput::success("6000"));
            mock.expect_run("curl", CmdOutput::success("packager-status:running"));
            mock.expect_run("qaren-request-probe", CmdOutput::success(""));
            mock.expect_run("expo-platform", CmdOutput::success(""));
        }
        if index > 1 {
            mock.expect_run("expo-platform", CmdOutput::success(""));
        }
        if index == 2 {
            mock.expect_run("defaults write", CmdOutput::success(""));
        }
        if index == 3 {
            common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
            common::script_ios_launch(&mut mock);
        }
        common::script_ios_metro_cleanup(&mut mock);
        mock.cancel_after = Some((hint.into(), "received SIGTERM".into()));
        req.runs_root = repo.join(format!("runs-{index}"));

        let (receipt, events) = run_with_events(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{substage}");
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::RunCancelled, "{substage}");
        assert_eq!(failure.phase, "build");
        assert_eq!(receipt.outcomes["substage"], substage);
        let trail = stage_trail(&events);
        assert!(
            trail.contains(&format!("{substage} failed RUN_CANCELLED")),
            "{trail:?}"
        );
        assert!(!trail.iter().any(|s| s == "install_launch_ready passed"));
        let record = RunRecord::load(&req.runs_root, &receipt.run_id).unwrap();
        assert_eq!(record.substage.as_deref(), Some(substage));
        assert_eq!(mock.remaining(), 0, "{substage}");
    }
}

#[test]
fn check_fails_fast_when_the_launched_ios_app_exits_and_names_the_missing_framework() {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/First.xcworkspace");
    configure_workspace(&app, "ios/First.xcworkspace", "Debug");
    let files = common::IOS_NATIVE_FILES;
    let mut seed = MockRunner::new();
    script_preflight(&mut seed, &repo);
    seed.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_provision_build(&mut seed, "xcodebuild", files);
    script_drift_status(&mut seed);
    script_host_probe(&mut seed, UDID, hosts_absent());
    seed.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut seed);
    script_teardown(&mut seed);
    let mut req = request(&repo, &app, 30);
    req.runs_root = repo.join("runs-seed");
    assert_eq!(run(&mut seed, &req).result, ReceiptResult::Pass);

    let home = repo.join("home");
    let reports = home.join("Library/Logs/DiagnosticReports");
    std::fs::create_dir_all(&reports).unwrap();
    let body = serde_json::json!({
        "procPath": format!("/Users/someone/Library/Developer/CoreSimulator/Devices/{UDID}/data/Containers/Bundle/Application/X/testapp.app/testapp"),
        "captureTime": "2026-02-02 02:40:01.0000 +0000",
        "exception": {"type": "EXC_CRASH"},
        "termination": {"namespace": "DYLD", "indicator": "Library missing", "reasons": ["Library not loaded: @rpath/ReactNativeDependencies.framework/ReactNativeDependencies"]},
    });
    std::fs::write(
        reports.join("testapp.ips"),
        format!("{{\"bundleID\":\"com.rndevagent.testapp\"}}\n{body}"),
    )
    .unwrap();
    let mut mock = MockRunner::new();
    mock.environment
        .insert("HOME".into(), home.to_string_lossy().into_owned());
    script_preflight(&mut mock, &repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(files));
    common::script_xcode(&mut mock);
    common::script_ios_app_verification(&mut mock);
    common::script_ios_metro_spawn(&mut mock);
    mock.expect_run("simctl install", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
    common::script_ios_launch(&mut mock);
    for _ in 0..2 {
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("S"));
        mock.expect_run("lsof", CmdOutput::success("6001"));
        mock.expect_run("ps", CmdOutput::success("6000"));
        mock.expect_run("curl", CmdOutput::success("packager-status:running"));
        mock.expect_run("simctl get_app_container", CmdOutput::success("/c/app"));
        mock.expect_run(
            "simctl spawn",
            CmdOutput::success("-\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
        );
    }
    common::script_ios_metro_cleanup(&mut mock);
    req.runs_root = repo.join("runs-exit");

    let (receipt, events) = run_with_events(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::AppExitedAtLaunch);
    assert_eq!(receipt.outcomes["substage"], "ready_probes");
    assert!(failure
        .detail
        .to_string()
        .contains("missing library ReactNativeDependencies.framework"));
    let detail = failure.detail.to_string();
    assert!(
        detail.contains("cannot load ReactNativeDependencies.framework")
            && detail.contains("prebuilt React Native pods mixed with source pods")
            && detail.ends_with("then re-run"),
        "{detail}"
    );
    assert_eq!(
        failure.next_action.to_string(),
        format!("qaren cleanup {} --json", receipt.run_id)
    );
    assert!(stage_trail(&events).contains(&"ready_probes failed APP_EXITED_AT_LAUNCH".to_string()));
    assert_eq!(mock.remaining(), 0);
}

// Metro answers on the second poll, so the scripted clock advances inside reuse readiness.
fn script_warm_launch_after_one_metro_retry(mock: &mut MockRunner) {
    common::script_ios_app_verification(mock);
    mock.expect_spawn(
        "expo start",
        qaren::exec::Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("node expo start"));
    mock.expect_run("simctl install", CmdOutput::success(""));
    for responding in [false, true] {
        mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
        mock.expect_run("ps", CmdOutput::success("S"));
        mock.expect_run("lsof", CmdOutput::success("6001"));
        mock.expect_run("ps", CmdOutput::success("6000"));
        mock.expect_run(
            "curl",
            match responding {
                true => CmdOutput::success("packager-status:running"),
                false => CmdOutput::failed(7, ""),
            },
        );
    }
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    common::script_devmenu_defaults(mock, CmdOutput::success(""));
    mock.expect_run(
        "simctl launch --terminate-running-process",
        CmdOutput::success(""),
    );
}

#[test]
fn android_check_waits_out_a_slow_first_app_process() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    // Twelve ticks span 55s without a PID, inside the first-PID grace.
    script_android_launch(&mut mock, 12);
    script_android_app_tick(&mut mock, CmdOutput::success("4242\n"));
    script_android_walk_release(&mut mock, false);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_check_fails_when_the_launched_app_never_shows_a_process() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_android_launch(&mut mock, 13);
    script_metro_teardown(&mut mock, EMULATOR, None);
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run("reverse --list", CmdOutput::success(""));

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::AppExitedAtLaunch);
    let detail = failure.detail.to_string();
    assert!(
        detail.contains("was not running 60s after") && detail.contains("adb logcat"),
        "{detail}"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_teardown_releases_before_the_lease() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    // The walk's runner is still up at teardown.
    script_android_launch_walk_release(&mut mock, true);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    // Both legs ran under the run's own lease, and only then was the lease released.
    assert_eq!(receipt.cleanup["adb_reverse"], "removed");
    assert_eq!(receipt.cleanup["android_runner"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    for leg in ["adb_server", "adb_connection", "app_install"] {
        assert!(!receipt.cleanup.contains_key(leg), "{leg}");
    }
    assert_eq!(mock.remaining(), 0);
    let adb = adb_calls(&mock);
    assert!(adb.last().unwrap().contains("dumpsys activity processes"));
    assert!(!adb
        .iter()
        .any(|c| c.contains("uninstall") || c.contains("kill-server")));
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert!(record.resources.lease.is_none());
}

#[test]
fn android_check_install_failure_and_timeout_keep_verified_apk_and_release_only_the_lease() {
    for (label, installed) in [
        (
            "install-failed",
            CmdOutput::failed(
                1,
                "adb: failed to install app-debug.apk: Write failed: Broken pipe",
            ),
        ),
        (
            "install-timeout",
            CmdOutput {
                timed_out: true,
                duration_ms: 300_000,
                ..Default::default()
            },
        ),
    ] {
        let (repo, app) = app_repo();
        let apk = seed_cached_apk(&repo, &app);
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(""));
        mock.expect_run("install -r -d", installed);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Failed, "{label}");
        let failure = receipt.failure.as_ref().expect("install must fail");
        assert_eq!(failure.code, FailureCode::ArtifactInstallFailed, "{label}");
        assert!(
            failure.detail.contains(&format!("({label}):")),
            "{label}: {}",
            failure.detail
        );
        assert!(
            failure.next_action.contains("keep the cached artifact"),
            "{label}: {}",
            failure.next_action
        );
        assert!(
            failure
                .next_action
                .contains("inspect the target device, package service, and transport state"),
            "{label}: {}",
            failure.next_action
        );
        for forbidden in ["delete", "rebuild", "re-run"] {
            assert!(
                !failure.next_action.contains(forbidden),
                "{label}: {forbidden} in {}",
                failure.next_action
            );
        }
        assert!(apk.is_file(), "{label}");
        assert_eq!(receipt.cleanup["device_lease"], "removed", "{label}");
        for leg in [
            "adb_reverse",
            "android_runner",
            "app_install",
            "adb_server",
            "adb_connection",
        ] {
            assert!(!receipt.cleanup.contains_key(leg), "{label}: {leg}");
        }
        assert!(
            !adb_calls(&mock).iter().any(|c| c.contains("reverse")
                || c.contains("uninstall")
                || c.contains("kill-server")
                || c.contains("force-stop")),
            "{label}"
        );
        assert_eq!(mock.remaining(), 0, "{label}");
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.app_install.is_none(), "{label}");
        assert_eq!(record.resources.adb_reverse_port, None, "{label}");
        assert!(record.resources.lease.is_none(), "{label}");
    }
}

#[test]
fn android_check_refuses_a_metro_port_already_reversed_on_the_emulator() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "install -r -d",
        CmdOutput::success("Performing Streamed Install\nSuccess\n"),
    );
    mock.expect_run(
        "reverse --no-rebind tcp:8791 tcp:8791",
        CmdOutput::failed(1, "adb: error: cannot rebind existing socket"),
    );

    let receipt = run(&mut mock, &req);

    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceBusy, "{failure:?}");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(failure.detail.contains("tcp:8791"));
    // The mapping belongs to someone else: it is neither taken over nor removed.
    assert!(!adb_calls(&mock)
        .iter()
        .any(|c| c.contains("reverse --remove")));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!receipt.cleanup.contains_key("adb_reverse"));
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.resources.adb_reverse_port, None);
}

#[test]
fn android_check_cancelled_before_reverse_leaves_an_existing_mapping() {
    let (repo, app) = app_repo();
    seed_cached_apk(&repo, &app);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "install -r -d",
        CmdOutput::success("Performing Streamed Install\nSuccess\n"),
    );
    // SIGTERM lands after the install, before this run's reverse command runs.
    mock.cancel_after = Some(("install -r -d".into(), "received SIGTERM".into()));

    let receipt = run(&mut mock, &req);

    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled, "{failure:?}");
    // tcp:8791 may already be reversed by something else: this run made no
    // mapping, so teardown leaves the port alone.
    assert!(!adb_calls(&mock).iter().any(|c| c.contains("reverse")));
    assert!(!receipt.cleanup.contains_key("adb_reverse"));
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.resources.adb_reverse_port, None);
    assert!(record.resources.lease.is_none());
}

fn script_android_pr_preflight(mock: &mut MockRunner, repo: &Path, wt: &Path, api: u16) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // invoking checkout
    mock.expect_run("gh pr view", pr_view_json(PR_HEAD));
    mock.expect_run("fetch origin pull/12/head", CmdOutput::success(""));
    mock.expect_run(
        "rev-parse refs/qaren/pr/",
        CmdOutput::success(&format!("{PR_HEAD}\n")),
    );
    mock.expect_run("update-ref -d", CmdOutput::success(""));
    script_plan(mock, repo);
    script_borrow_api(mock, ONE_EMULATOR, EMULATOR, api);
    mock.expect_run("worktree add --detach", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", wt.display()))); // toplevel of the worktree
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", wt.display()))); // explicit worktree
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
    mock.expect_run("git", CmdOutput::success(""));
    for tool in ANDROID_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run(
        "QAREN_PNPM_LAUNCH_GROUP",
        CmdOutput::success(qaren::adapters::pnpm::GROUP_OK),
    );
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren pr\n"));
    mock.expect_run("lsof", free_port());
}

fn script_android_pr_ready(mock: &mut MockRunner) {
    mock.expect_run(
        "install -r -d",
        CmdOutput::success("Performing Streamed Install\nSuccess\n"),
    );
    mock.expect_run(
        "reverse --no-rebind tcp:8791 tcp:8791",
        CmdOutput::success("8791\n"),
    );
    mock.expect_spawn(
        "expo start",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("node expo start"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("am start", CmdOutput::success("Starting: Intent"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "pm path com.rndevagent.testapp",
        CmdOutput::success("package:/data/app/~~x/com.rndevagent.testapp/base.apk\n"),
    );
    mock.expect_run("pidof com.rndevagent.testapp", CmdOutput::success("4242\n"));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
}

#[test]
fn android_pr_on_api_37_starts_the_recorder() {
    android_pr_video_flow(37);
}

#[test]
fn android_pr_on_api_33_keeps_the_walk_with_an_explicit_video_unavailable_reason() {
    android_pr_video_flow(33);
}

fn android_pr_video_flow(api: u16) {
    let (repo, app) = app_repo();
    let mut req = android_request(&repo, &app);
    req.pr = pr_request(&repo, &app).pr;
    let wt = req.runs_root.join(run_id()).join("wt");
    let mut runner = PrRunner {
        inner: android_mock(),
        app: app.clone(),
        recorder_persisted_before_spawn: None,
        fail_core_spawn: false,
        planted_worktree_config: None,
        worktree_config_planted: false,
    };
    let mock = &mut runner.inner;
    script_android_pr_preflight(mock, &repo, &wt, api);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(mock, PREBUILD, 5000, 0);
    script_android_finite_build(mock, GRADLE, 5001, 0);
    script_android_pr_ready(mock);
    if api >= 34 {
        mock.expect_run("shell rm -f", CmdOutput::success(""));
        mock.expect_spawn(
            "shell screenrecord --time-limit 0 --bit-rate 4000000",
            Spawned {
                pid: 7100,
                pgid: 7100,
            },
        );
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("adb shell screenrecord"));
        mock.expect_run("shell pgrep -f", CmdOutput::success("42\n"));
    }
    mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
    script_core_identity(mock);
    script_drift_status(mock);
    script_pr_provenance_recheck(mock);
    if api >= 34 {
        mock.expect_run(
            "adb version",
            CmdOutput::success("Android Debug Bridge version 1.0.41"),
        );
        mock.expect_run("shell pkill -INT -f", CmdOutput::success(""));
        mock.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        mock.expect_run("pull", CmdOutput::success(""));
        mock.expect_run("shell rm -f", CmdOutput::success(""));
    }
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    script_metro_teardown(mock, EMULATOR, None);
    script_borrowed_release(mock, false);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    if api >= 34 {
        mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
    }
    mock.expect_run(
        "gh pr view https://github.com/o/r/pull/12",
        pr_view_json(PR_MOVED),
    );

    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    if api >= 34 {
        assert_eq!(runner.recorder_persisted_before_spawn, Some(true));
        assert_subsequence(
            &labels(&runner.inner),
            &[
                "adb-screenrecord",
                "core-walk",
                "adb-device-pkill",
                "adb-pull",
                "adb-rm",
                "adb-reverse-remove",
            ],
        );
        assert_eq!(receipt.cleanup["recorder"], "removed");
    } else {
        assert_eq!(runner.recorder_persisted_before_spawn, None);
        assert!(labels(&runner.inner)
            .iter()
            .any(|label| label == "core-walk"));
        assert!(!labels(&runner.inner)
            .iter()
            .any(|label| label == "adb-screenrecord"));
        assert_eq!(
            receipt.outcomes["video"],
            "unavailable(Android API <34 stops screen recording at 180 s)"
        );
    }
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(runner.inner.remaining(), 0);
    no_ios_or_expo_android_build(&runner.inner);
}

struct DeadlineCase {
    block: &'static str,
    deps: u64,
    build: u64,
    boot: u64,
}

fn deadline_cases() -> [DeadlineCase; 3] {
    [
        DeadlineCase {
            block: "",
            deps: 900,
            build: 2400,
            boot: 420,
        },
        DeadlineCase {
            block: "deadlines:\n  build_seconds: 5400\n",
            deps: 900,
            build: 5400,
            boot: 420,
        },
        DeadlineCase {
            block: "deadlines:\n  install_deps_seconds: 120\n  build_seconds: 5400\n  device_boot_seconds: 90\n",
            deps: 120,
            build: 5400,
            boot: 90,
        },
    ]
}

fn write_operator_config(app: &Path, block: &str) -> String {
    let yaml = format!(
        "appId: com.rndevagent.testapp\nmetroPort: 8791\ndevClientScheme: rndatest\n{block}"
    );
    std::fs::write(app.join(".qaren/config.yaml"), &yaml).unwrap();
    yaml
}

fn command_timeout(mock: &MockRunner, label: &str) -> u64 {
    mock.calls
        .iter()
        .find(|call| call.label == label)
        .unwrap_or_else(|| panic!("missing {label}"))
        .timeout_seconds
}

fn record_from_receipt(receipt: &qaren::receipt::Receipt) -> RunRecord {
    let path = &receipt.artifacts["run_record"];
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn assert_effective_deadlines(record: &RunRecord, case: &DeadlineCase, raw: &str) {
    assert_eq!(record.scenario.deadlines.install_deps_seconds, case.deps);
    assert_eq!(record.scenario.deadlines.build_seconds, case.build);
    assert_eq!(record.scenario.deadlines.device_boot_seconds, case.boot);
    assert_eq!(
        record.scenario_sha256,
        qaren::candidate::sha256_hex(raw.as_bytes())
    );
}

fn script_check_with_boot(mock: &mut MockRunner, repo: &Path) {
    script_preflight_inventory(
        mock,
        repo,
        "simctl list devices -j",
        &available_inventory("Shutdown"),
    );
    script_admission(mock);
    common::script_ios_deps(mock);
    script_admission(mock);
    mock.expect_run(
        &format!("simctl bootstatus {UDID} -b"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&available_inventory("Booted")),
    );
    script_provision_after_deps(mock);
    script_drift_status(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(mock);
    script_teardown(mock);
}

fn script_pr_pass(mock: &mut MockRunner, repo: &Path, wt: &Path) {
    script_pr_preflight(mock, repo, wt);
    script_pr_provision(mock);
    script_pr_provenance_recheck(mock);
    script_drift_status(mock);
    script_recorder_start(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pr_pass_stdout(), Some(0));
    script_core_identity(mock);
    script_drift_status(mock);
    mock.expect_run("git", CmdOutput::success(&format!("{PR_HEAD}\n")));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/actions/tasks.yaml\0"),
    );
    script_recorder_stop(mock);
    script_pr_teardown_after_drift(mock);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
    mock.expect_run(
        "gh pr view https://github.com/o/r/pull/12",
        pr_view_json(PR_MOVED),
    );
}

#[test]
fn check_persists_configured_deadlines_and_uses_them_as_command_budgets() {
    for case in deadline_cases() {
        let (repo, app) = app_repo();
        let raw = write_operator_config(&app, case.block);
        let mut mock = MockRunner::new();
        script_check_with_boot(&mut mock, &repo);
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.to_lowercase());
        req.boot_device = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        assert_eq!(std::fs::read_to_string(&req.config_path).unwrap(), raw);
        let record = record_from_receipt(&receipt);
        assert_effective_deadlines(&record, &case, &raw);
        assert_eq!(record.scenario_path, req.config_path);
        assert_eq!(command_timeout(&mock, "pnpm-install"), case.deps);
        assert_eq!(command_timeout(&mock, "expo-run-ios"), case.build);
        assert_eq!(command_timeout(&mock, "simctl-bootstatus"), case.boot);
    }
}

#[test]
fn pr_uses_the_operator_config_deadlines_not_the_worktree_config() {
    let conflicting = "appId: com.other.app\ndevClientScheme: other\ndeadlines:\n  install_deps_seconds: 30\n  build_seconds: 31\n  device_boot_seconds: 32\n";
    for case in deadline_cases() {
        let (repo, app) = app_repo();
        let raw = write_operator_config(&app, case.block);
        let wt = repo.join("runs").join(run_id()).join("wt");
        let mut runner = PrRunner {
            inner: MockRunner::new(),
            app: app.clone(),
            recorder_persisted_before_spawn: None,
            fail_core_spawn: false,
            planted_worktree_config: Some(conflicting.into()),
            worktree_config_planted: false,
        };
        script_pr_pass(&mut runner.inner, &repo, &wt);
        let receipt = run(&mut runner, &pr_request(&repo, &app));
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(runner.inner.remaining(), 0);
        assert!(runner.worktree_config_planted);
        assert_eq!(
            std::fs::read_to_string(&app.join(".qaren/config.yaml")).unwrap(),
            raw
        );
        let record = record_from_receipt(&receipt);
        assert_effective_deadlines(&record, &case, &raw);
        assert_eq!(record.scenario_path, app.join(".qaren/config.yaml"));
        assert_eq!(command_timeout(&runner.inner, "pnpm-install"), case.deps);
        assert_eq!(command_timeout(&runner.inner, "expo-run-ios"), case.build);
    }
}

#[test]
fn android_check_uses_configured_deadlines_for_dependency_install_and_build() {
    let (repo, app) = app_repo();
    let case = DeadlineCase {
        block: "deadlines:\n  install_deps_seconds: 120\n  build_seconds: 5400\n  device_boot_seconds: 90\n",
        deps: 120,
        build: 5400,
        boot: 90,
    };
    let raw = write_operator_config(&app, case.block);
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch_walk_teardown(&mut mock);
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    let record = record_from_receipt(&receipt);
    assert_effective_deadlines(&record, &case, &raw);
    assert_eq!(command_timeout(&mock, "pnpm-install"), case.deps);
    assert_eq!(command_timeout(&mock, "expo-prebuild"), case.build);
    assert_eq!(command_timeout(&mock, "gradle-assemble"), case.build);
}

#[test]
fn unsafe_native_root_fails_check_and_releases_the_existing_device_lease() {
    use std::os::unix::fs::DirBuilderExt;
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/Native.xcworkspace");
    configure_workspace(&app, "ios/Native.xcworkspace", "Native");
    let req = request(&repo, &app, 30);
    std::fs::DirBuilder::new()
        .mode(0o755)
        .create(&req.native_cache_root)
        .unwrap();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
    common::script_xcode(&mut mock);
    let receipt = run(&mut mock, &req);
    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{:?}",
        receipt.failure
    );
    assert_eq!(receipt.failure.unwrap().code, FailureCode::PrereqMissing);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(receipt.build.is_none());
    assert_eq!(mock.remaining(), 0);
    assert!(!mock.calls.iter().any(|c| c.label == "simctl-install"));
}

#[test]
fn saved_login_hints_use_names_and_the_first_screen_without_publishing_them() {
    for (written, configured, label, signs_out, foreign, linked, nested) in [
        (true, false, false, false, false, false, false),
        (true, false, false, false, false, true, false),
        (false, false, true, false, false, false, false),
        (true, true, false, false, false, false, false),
        (true, true, false, true, false, false, false),
        (true, false, false, false, true, false, false),
        (true, false, false, false, false, true, true),
    ] {
        let (repo, project) = app_repo();
        let app = if nested {
            let app = project.join("mobile");
            std::fs::create_dir_all(app.join(".qaren")).unwrap();
            std::fs::copy(
                project.join(".qaren/config.yaml"),
                app.join(".qaren/config.yaml"),
            )
            .unwrap();
            app
        } else {
            project.clone()
        };
        if configured {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .append(true)
                .open(app.join(".qaren/config.yaml"))
                .unwrap()
                .write_all(b"loginBlock: sign-in\nloginMarker:\n  id: login-email\n")
                .unwrap();
        }
        let marker = if label {
            "text: \"Email\""
        } else {
            "id: \"login-email\""
        };
        let sign_out = if signs_out {
            "# 1. Tap Log out\n- tapOn: { text: \"Log out\" }\n"
        } else {
            ""
        };
        let app_id = if foreign {
            "com.other.app"
        } else {
            "com.rndevagent.testapp"
        };
        std::fs::create_dir_all(app.join(".qaren/actions")).unwrap();
        std::fs::write(app.join(".qaren/actions/sign-in.yaml"), format!(
            "appId: {app_id}\n---\n# id: sign-in\n# intent: Sign in\n# appId: {app_id}\n# platform: ios\n\n{sign_out}# 1. Fill email\n- tapOn: {{ {marker} }}\n- inputText: {{ input: USERNAME }}\n# 2. Fill password\n- tapOn: {{ id: password }}\n- inputText: {{ input: PASSWORD }}\n"
        )).unwrap();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        script_drift_status(&mut mock);
        let source = if written { "discovered" } else { "replayed" };
        let mut ledger = serde_json::json!({"verdict":"PASS","path":"walk","blocks":[{"key":"sign-in","outcome":"pass","source":source}],"steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0});
        if written {
            ledger["blocksWritten"] = serde_json::json!(["sign-in"]);
        }
        script_host_probe(&mut mock, UDID, hosts_absent());
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &ledger.to_string())),
            Some(0),
        );
        script_core_identity(&mut mock);
        script_drift_status(&mut mock);
        script_final_verification(&mut mock);
        if written {
            mock.expect_run(
                "--git-common-dir",
                CmdOutput::success(if linked {
                    "/repo/.git/worktrees/task\n/repo/.git\n"
                } else {
                    "/repo/.git\n/repo/.git\n"
                }),
            );
        }
        script_teardown_resources(
            &mut mock,
            CmdOutput::success("1 1 S\n6000 6000 S\n"),
            false,
            UDID,
            Some(hosts_absent()),
        );
        let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries([(
            "QAREN_INPUT_PASSWORD".into(),
            "sentinel-value-123".into(),
        )]));
        let mut req = request(&repo, &project, 30);
        req.config_path = app.join(".qaren/config.yaml");
        let receipt = qaren::redact::with_input_scope(inputs, || run(&mut mock, &req));
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(mock.remaining(), 0);
        if written {
            let corpus = mock
                .calls
                .iter()
                .find(|call| call.args.iter().any(|arg| arg == "--git-common-dir"))
                .unwrap();
            assert_eq!(
                corpus.cwd.as_ref().unwrap().canonicalize().unwrap(),
                app.canonicalize().unwrap()
            );
        }
        let json = receipt.to_json();
        assert!(!json.contains("sentinel-value-123"));
        if foreign || (configured && !signs_out) {
            assert!(receipt.hints.is_empty());
        } else if signs_out {
            assert_eq!(receipt.hints[0].code, "LOGIN_BLOCK_SIGNS_OUT");
            assert!(!receipt.hints[0].text.contains("loginMarker:"));
        } else {
            assert_eq!(receipt.hints[0].code, "LOGIN_BLOCK_CANDIDATE");
            assert_eq!(receipt.hints[0].text, format!(
                "▸ login: block \"sign-in\" is a likely login block with runtime inputs USERNAME, PASSWORD.\n  Confirm it signs in; then, to replay it whenever its first screen appears, add to .qaren/config.yaml:\n    loginBlock: sign-in\n    loginMarker:\n      {marker}\n  Every run then needs QAREN_INPUT_USERNAME and QAREN_INPUT_PASSWORD set."
            ));
        }
        if linked {
            assert_eq!(receipt.hints.len(), 2);
            assert_eq!(receipt.hints[1].code, "CORPUS_NOT_SHARED");
            assert!(receipt.hints[1]
                .text
                .starts_with("▸ saved blocks: 1 written"));
            assert!(receipt.hints[1]
                .text
                .contains("then: ln -s <main>/<app>/.qaren/actions .qaren/actions"));
        }
        let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
        assert!(!report.contains("loginMarker:"));
        assert!(!report.contains("login-email"));
    }
}

#[test]
fn video_declaration_reaches_the_child_and_durable_run_outputs() {
    for policy in [None, Some("strict"), Some("non-strict")] {
        for selected in [
            ".qaren/config.yaml",
            ".qaren/target.yaml",
            "external",
            "external-parent",
        ] {
            let (repo, app) = app_repo();
            let mut req = request(&repo, &app, 30);
            if selected != ".qaren/config.yaml" {
                let path = if selected == "external" {
                    repo.join("selected.yaml")
                } else if selected == "external-parent" {
                    app.join("../selected.yaml")
                } else {
                    app.join(selected)
                };
                std::fs::copy(&req.config_path, &path).unwrap();
                req.config_path = path;
            }
            assert!(req.config_path.is_absolute());
            let source = if selected.starts_with("external") {
                "external config (selected.yaml)"
            } else {
                selected
            };
            if let Some(policy) = policy {
                let yaml = std::fs::read_to_string(&req.config_path).unwrap();
                std::fs::write(&req.config_path, format!("{yaml}video: {policy}\n")).unwrap();
            }
            let mut mock = MockRunner::new();
            script_preflight(&mut mock, &repo);
            script_provision(&mut mock);
            script_drift_status(&mut mock);
            script_host_probe(&mut mock, UDID, hosts_absent());
            mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
            script_core_identity(&mut mock);
            script_teardown(&mut mock);
            let receipt = run(&mut mock, &req);
            assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
            let expected = policy.unwrap_or("undeclared");
            assert_eq!(receipt.outcomes["video_policy"], expected);
            assert_eq!(receipt.outcomes["video_policy_source"], source);
            let request: serde_json::Value =
                serde_json::from_str(mock.piped_stdin_text(1).trim()).unwrap();
            assert_eq!(request["payload"]["videoPolicy"], expected);
            let ledger: serde_json::Value = serde_json::from_slice(
                &std::fs::read(repo.join("runs").join(run_id()).join("ledger.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(ledger["videoPolicy"], expected);
            assert_eq!(ledger["videoPolicySource"], source);
            let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
            assert!(report.contains("Video policy:"));
            assert!(report.contains(source));
            let ledger: qaren::core::Ledger = serde_json::from_value(ledger).unwrap();
            let body = qaren::report::render_pr_comment(
                &qaren::report::ReportInput {
                    run_id: "check-policy",
                    platform: "ios",
                    app_id: "com.test",
                    device: "test",
                    ledger: &ledger,
                },
                None,
                &qaren::report::PrRun {
                    tested_sha: PR_HEAD,
                    tested_older_commit: false,
                    video: &qaren::record::VideoStatus::Available,
                    screenshot: None,
                    plan_sha256: "0",
                    video_publication: &qaren::record::VideoPublication::WithheldPrivacy,
                },
                &qaren::redact::MachineIdentity::default(),
            );
            assert!(body.contains(source), "{body}");
            assert!(!body.contains(&repo.display().to_string()), "{body}");
            if policy.is_none() {
                assert!(
                    body.contains(&format!("declare video: non-strict in {source}.")),
                    "{body}"
                );
            }
            assert_eq!(mock.remaining(), 0);
        }
    }
}

#[test]
fn part_a_dependency_failure_only_tears_down_infrastructure() {
    for cancelled in [false, true] {
        let (repo, app) = app_repo();
        std::fs::write(
            app.join("plan.md"),
            "## QA\n1. Go back\n\n## Cleanup\n1. Go back\n",
        )
        .unwrap();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        mock.expect_run(
            "pnpm install --frozen-lockfile",
            CmdOutput::failed(1, "fixture stop"),
        );
        if cancelled {
            mock.cancel_after = Some((
                "pnpm install --frozen-lockfile".to_string(),
                "fixture cancellation".to_string(),
            ));
        }

        let receipt = run(&mut mock, &request(&repo, &app, 30));

        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            if cancelled {
                FailureCode::RunCancelled
            } else {
                FailureCode::DepsInstallFailed
            }
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!receipt.cleanup.contains_key("plan"));
        assert!(mock.piped_stdin.is_empty());
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn unverified_selection_receipts_keep_evidence_guidance_and_ordered_recovery() {
    for code in [
        "PRESS_NOT_REGISTERED",
        "NATIVE_CAPTURE_UNAVAILABLE",
        "ITEM_DEADLINE_EXCEEDED",
        "EVIDENCE_EXPIRED",
        "RUN_CANCELLED",
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        let evidence = serde_json::json!({"subreason":"selection_unverified","heldPress":"not_tried_unsafe","outsideTargetChange":true,"captures":2});
        let ledger = serde_json::json!({
            "verdict":"REFUSED", "code":code,
            "message":"Selection could not be verified; no second press was sent.",
            "path":"replay", "blocks":[{"key":"plan","outcome":"fail","source":"replayed"}],
            "steps":[], "jev":{"calls":0,"medianMs":0}, "llmTurns":0,"escapes":0,"recoveries":0,
            "pressEvidence":evidence,
            "failure":{"step":1,"seen":"Selection could not be verified; no second press was sent."}
        });
        script_recipe_walk(&mut mock, &repo, &ledger.to_string(), 4);
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{code}: {:?}",
            receipt.failure
        );
        let failure = receipt.failure.as_ref().unwrap();
        if code == "PRESS_NOT_REGISTERED" {
            assert_eq!(failure.code, FailureCode::PressNotRegistered);
            assert!(failure.code.is_refusal());
        }
        let expected = if code == "PRESS_NOT_REGISTERED" {
            "rerun_then_ask_app_team_expose_selection_in_row_list"
        } else if code == "NATIVE_CAPTURE_UNAVAILABLE" {
            "reprepare_after_capture_recovery"
        } else {
            "rerun_when_ready"
        };
        assert_eq!(failure.next_action.as_str(), expected);
        let recovery = serde_json::to_value(failure).unwrap()["recovery"].clone();
        assert_eq!(recovery["action"], expected);
        assert_eq!(
            recovery["destroys_state"],
            code == "NATIVE_CAPTURE_UNAVAILABLE"
        );
        assert_eq!(
            recovery["requires_user_ok"],
            code == "NATIVE_CAPTURE_UNAVAILABLE"
        );
        assert_eq!(
            recovery["next_rung"],
            if code == "NATIVE_CAPTURE_UNAVAILABLE" {
                serde_json::json!(2)
            } else {
                serde_json::Value::Null
            }
        );
        assert_eq!(recovery["ladder"].as_array().unwrap().len(), 5);
        for (index, rung) in recovery["ladder"].as_array().unwrap().iter().enumerate() {
            assert_eq!(rung["rung"], index + 1);
            assert_eq!(
                rung["status"],
                if code == "NATIVE_CAPTURE_UNAVAILABLE" && index > 0 {
                    "available"
                } else {
                    "skipped"
                }
            );
        }
        let durable: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&receipt.artifacts["ledger"]).unwrap())
                .unwrap();
        assert_eq!(durable["pressEvidence"], evidence);
        assert!(durable.get("recipe").is_none());
        assert!(durable["failure"].get("kind").is_none());
        assert!(!receipt.to_json().contains("CANARY"));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn first_capture_fault_requires_reprepare_after_the_walk_has_exited() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    let ledger = serde_json::json!({"verdict":"REFUSED","code":"NATIVE_CAPTURE_UNAVAILABLE","message":"Native capture unavailable.","pressEvidence":{"subreason":"target_identity_unavailable","heldPress":"not_tried_unsafe","outsideTargetChange":false,"captures":1}});
    script_recipe_walk(&mut mock, &repo, &ledger.to_string(), 4);
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(
        failure.next_action.as_str(),
        "reprepare_after_capture_recovery"
    );
    let recovery = serde_json::to_value(failure).unwrap()["recovery"].clone();
    assert_eq!(recovery["next_rung"], 2);
    assert_eq!(recovery["destroys_state"], true);
    assert_eq!(recovery["requires_user_ok"], true);
    assert_eq!(recovery["ladder"][0]["action"], "held_press");
    assert_eq!(recovery["ladder"][0]["status"], "skipped");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn fresh_install_reprobe_keeps_the_final_busy_verdict_at_both_admission_points() {
    for after_deps in [false, true] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        if after_deps {
            script_admission(&mut mock);
            common::script_ios_deps(&mut mock);
        }
        for (status, reason) in [
            ("unknown", "executable_identity_unproven"),
            ("busy", "driver_on_selected_device"),
        ] {
            mock.expect_run(
                "fresh-install-preflight.js",
                CmdOutput {
                    exit_code: Some(4),
                    stdout:
                        serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":status,
                    "evidence":{"reason":reason,"pid":812}})
                        .to_string(),
                    ..Default::default()
                },
            );
        }
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{}",
            receipt.to_json()
        );
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.code, FailureCode::DeviceBusy);
        assert!(failure
            .next_action
            .contains("wait for the foreign process owner"));
        assert_eq!(
            failure.build_recovery().unwrap().action,
            qaren::failure::RecoveryAction::WaitForOwner
        );
        assert!(failure
            .detail
            .as_str()
            .contains("driver_on_selected_device"));
        assert_eq!(mock.remaining(), 0);
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "simctl-uninstall" | "simctl-install" | "expo-run-ios"
        )));
    }
}

#[test]
fn fresh_install_cancelled_admission_retains_its_attempt_summary() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    mock.cancel_after = Some(("fresh-install-preflight.js".into(), "cancelled".into()));
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut mock, &req);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled);
    let summary: serde_json::Value = serde_json::from_str(failure.evidence[0].as_str()).unwrap();
    assert_eq!(summary["attempts"], 1);
    assert_eq!(summary["terminalReason"], "cancelled");
    assert_eq!(mock.remaining(), 0);
}
