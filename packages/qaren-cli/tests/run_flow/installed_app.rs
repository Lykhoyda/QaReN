use super::*;

const APP_ID: &str = "com.rndevagent.testapp";

// A release build as the simulator holds it: an embedded bundle and an executable.
fn installed_bundle(repo: &Path, js: Option<&str>) -> PathBuf {
    let bundle = repo.join("installed/rndevagenttest.app");
    std::fs::create_dir_all(&bundle).unwrap();
    if let Some(js) = js {
        std::fs::write(bundle.join("main.jsbundle"), js).unwrap();
    }
    std::fs::write(bundle.join("rndevagenttest"), "release executable").unwrap();
    bundle
}

fn installed_request(repo: &Path, app: &Path) -> RunRequest {
    let mut req = request(repo, app, 30);
    req.installed_app = true;
    req
}

// Preflight of an installed-app check: no pnpm, no Metro port; the tool check names only git, node, ps and xcrun.
fn script_installed_preflight(mock: &mut MockRunner, repo: &Path) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(mock, repo);
    script_installed_device(mock, repo);
}

fn script_installed_device(mock: &mut MockRunner, repo: &Path) {
    mock.expect_run("simctl list devices -j", CmdOutput::success(&booted_json()));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(UNTRACKED_PLAN));
    for tool in ["git", "node", "ps", "xcrun"] {
        mock.expect_run(
            &format!("which {tool}"),
            CmdOutput::success(&format!("/usr/bin/{tool}\n")),
        );
    }
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren check\n"));
}

fn container(bundle: &Path) -> CmdOutput {
    CmdOutput::success(&format!("{}\n", bundle.display()))
}

// The installed app's admission and its plain launch.
fn script_installed_launch(mock: &mut MockRunner, bundle: &Path) {
    script_app_presence(mock, true);
    mock.expect_run("simctl get_app_container", container(bundle));
    mock.expect_run(
        "Info.plist",
        CmdOutput::success(
            r#"{"CFBundleShortVersionString":"1.4.0","CFBundleVersion":"42","CFBundleExecutable":"rndevagenttest"}"#,
        ),
    );
    mock.expect_run("simctl launch --terminate-running-process", CmdOutput::success(""));
}

// The walk and what follows it: the post-walk read of the installed bundle, then core and host teardown.
fn script_installed_walk(mock: &mut MockRunner, stdout: &str, exit: i32, after: CmdOutput) {
    script_installed_core(mock, stdout, exit);
    script_installed_teardown(mock, after, false);
}

fn script_installed_core(mock: &mut MockRunner, stdout: &str, exit: i32) {
    mock.expect_run("(exclude).qaren/actions", CmdOutput::success(""));
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, stdout, Some(exit));
    script_core_identity(mock);
}

fn script_installed_teardown(mock: &mut MockRunner, after: CmdOutput, driver: bool) {
    mock.expect_run("(exclude).qaren/actions", CmdOutput::success(""));
    mock.expect_run("simctl get_app_container", after);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    if driver {
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        mock.expect_run("ps -p 9001 -o lstart=", CmdOutput::success(""));
    }
    script_host_probe(mock, UDID, hosts_absent());
}

fn device_changing(mock: &MockRunner) -> Vec<String> {
    mock.calls
        .iter()
        .filter(|c| {
            c.label.starts_with("simctl-")
                && !matches!(
                    c.label.as_str(),
                    "simctl-list" | "simctl-app-container" | "simctl-launchctl" | "simctl-listapps"
                )
        })
        .map(|c| c.rendered())
        .collect()
}

#[test]
fn installed_app_walks_the_installed_release_build_and_leaves_it_in_place() {
    let (repo, app) = app_repo();
    let bundle = installed_bundle(&repo, Some("release javascript"));
    let mut mock = MockRunner::new();
    script_installed_preflight(&mut mock, &repo);
    script_installed_launch(&mut mock, &bundle);
    script_installed_walk(&mut mock, &pass_stdout(), 0, container(&bundle));
    let req = installed_request(&repo, &app);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0);
    let launch = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-launch")
        .unwrap();
    assert_eq!(
        launch.args,
        vec!["simctl", "launch", "--terminate-running-process", UDID, APP_ID]
    );
    assert_eq!(device_changing(&mock), vec![launch.rendered()]);
    for absent in [
        "simctl-install",
        "simctl-uninstall",
        "simctl-devmenu-defaults",
        "simctl-lane-defaults",
        "expo-start",
        "pnpm-install",
    ] {
        assert!(!labels(&mock).iter().any(|l| l == absent), "{absent}");
    }
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.rendered().contains("pnpm") || c.rendered().contains("lsof")));
    let sha = |name: &str| qaren::candidate::sha256_hex(&std::fs::read(bundle.join(name)).unwrap());
    assert_eq!(receipt.outcomes["app_source"], "installed");
    assert_eq!(receipt.outcomes["installed_app_version"], "1.4.0");
    assert_eq!(receipt.outcomes["installed_app_build"], "42");
    assert_eq!(receipt.outcomes["installed_app_js_sha256"], sha("main.jsbundle"));
    assert_eq!(
        receipt.outcomes["installed_app_executable_sha256"],
        sha("rndevagenttest")
    );
    assert_eq!(
        receipt.outcomes["source_proof"],
        "none: the app's JavaScript is not proven to come from this checkout"
    );
    assert_eq!(receipt.outcomes["candidate_drift"], "none");
}

#[test]
fn installed_app_receipt_keeps_start_refusal_guidance_with_private_output_withheld() {
    let timeout_next = "re-run once: a first start on a simulator builds or downloads QaReN's runner, and a later start is faster; if it repeats, report the code with the run id";
    let read_next = "re-run once; if it repeats, report the code with the run id: QaReN's runner could not read the installed app";
    for (code, expected_next, driver) in [
        ("INSTALLED_APP_OPEN_TIMEOUT", timeout_next, false),
        (
            "INSTALLED_APP_PROCESS_UNPROVEN",
            "start the app by hand on the simulator and check that it stays open, then re-run: installed-app mode needs the launched app to keep running",
            false,
        ),
        ("INSTALLED_APP_BIND_FAILED", read_next, false),
        ("INSTALLED_APP_READ_FAILED", read_next, false),
        ("BUSY_FOREIGN_FLOW", "resolve the refusal, then re-run", false),
        ("INSTALLED_APP_OPEN_TIMEOUT", timeout_next, true),
    ] {
        let (repo, app) = app_repo();
        let bundle = installed_bundle(&repo, Some("release javascript"));
        let mut mock = MockRunner::new();
        script_installed_preflight(&mut mock, &repo);
        script_installed_launch(&mut mock, &bundle);
        let result = serde_json::json!({
            "verdict": "REFUSED",
            "code": code,
            "message": "[private output withheld]",
        });
        let result = envelope(3, "result", &result.to_string());
        let stdout = if driver {
            let resource = envelope(2, "resource", r#"{"kind":"runner_driver","pid":9001}"#);
            format!("{resource}\n{result}\n")
        } else {
            format!("{result}\n")
        };
        script_installed_core(&mut mock, &stdout, 4);
        if driver {
            mock.expect_run("ps -o pgid= -p 9001", CmdOutput::success("9001\n"));
            mock.expect_run("ps -p 9001 -o lstart=", CmdOutput::success(LSTART));
            mock.expect_run(
                "ps -p 9001 -o command=",
                CmdOutput::success(&format!("xcodebuild test-without-building -destination id={UDID}")),
            );
        }
        script_installed_teardown(&mut mock, container(&bundle), driver);

        let receipt = run(&mut mock, &installed_request(&repo, &app));

        assert_eq!(receipt.result, ReceiptResult::Refused, "{code}");
        if driver {
            assert!(receipt.cleanup.contains_key("runner_driver"), "{receipt:?}");
        }
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.code, FailureCode::CoreRefused);
        assert_eq!(failure.detail, format!("{code}: [private output withheld]"));
        assert_eq!(failure.next_action, expected_next, "{code}");
        assert_eq!(
            failure.suggestion.as_deref(),
            (code != "BUSY_FOREIGN_FLOW").then_some(expected_next),
            "{code}"
        );
        assert_eq!(failure.phase, "prove");
        assert!(failure.recovery.is_none());
        let launch = mock.calls.iter().find(|call| call.label == "simctl-launch").unwrap();
        assert_eq!(device_changing(&mock), vec![launch.rendered()]);
        assert_eq!(mock.remaining(), 0, "{code}");
    }
}

#[test]
fn installed_app_refuses_a_missing_or_development_app_before_any_launch() {
    for (case, code, own_next) in [
        (
            "not installed",
            FailureCode::InstalledAppMissing,
            "install the build you want to test on this simulator, then re-run; or drop --installed-app to let QaReN build and install its development build",
        ),
        (
            "development build",
            FailureCode::InstalledAppNotStandalone,
            "drop --installed-app to test this development build with Metro; or install a release build and re-run",
        ),
    ] {
        let (repo, app) = app_repo();
        let bundle = installed_bundle(&repo, None);
        let mut mock = MockRunner::new();
        script_installed_preflight(&mut mock, &repo);
        if code == FailureCode::InstalledAppMissing {
            script_app_presence(&mut mock, false);
        } else {
            script_app_presence(&mut mock, true);
            mock.expect_run("simctl get_app_container", container(&bundle));
        }
        let req = installed_request(&repo, &app);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{case}");
        assert_eq!(mock.remaining(), 0, "{case}");
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, code, "{case}");
        assert!(
            !labels(&mock).iter().any(|l| l == "simctl-launch"),
            "{case}"
        );
        assert!(device_changing(&mock).is_empty(), "{case}");
        assert!(
            receipt
                .next_action
                .starts_with(&format!("qaren cleanup {} --json", run_id())),
            "{case}: {}",
            receipt.next_action
        );
        assert!(
            receipt.next_action.ends_with(&format!("; then {own_next}")),
            "{case}: {}",
            receipt.next_action
        );
    }
}

#[test]
fn installed_app_forces_strict_media_rules_and_names_the_mode_to_the_core() {
    let (repo, app) = app_repo();
    let config = app.join(".qaren/config.yaml");
    let mut yaml = std::fs::read_to_string(&config).unwrap();
    yaml.push_str("video: non-strict\n");
    std::fs::write(&config, yaml).unwrap();
    let bundle = installed_bundle(&repo, Some("release javascript"));
    let mut mock = MockRunner::new();
    script_installed_preflight(&mut mock, &repo);
    script_installed_launch(&mut mock, &bundle);
    script_installed_walk(&mut mock, &pass_stdout(), 0, container(&bundle));

    let receipt = run(&mut mock, &installed_request(&repo, &app));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let payload = core_request_payload(&mock);
    assert_eq!(payload["videoPolicy"], "strict");
    assert_eq!(payload["appSource"], "installed");
    assert_eq!(receipt.outcomes["video_policy"], "strict");
    assert_eq!(receipt.outcomes["video_policy_source"], "installed-app mode");
    assert!(
        !receipt.outcomes["video"].contains("--record"),
        "{}",
        receipt.outcomes["video"]
    );
}

#[test]
fn installed_app_refuses_flag_pairs_it_cannot_serve_before_any_device_command() {
    let (repo, app) = app_repo();
    for (case, edit, next) in [
        (
            "fresh install",
            Box::new(|req: &mut RunRequest| req.fresh_install = true) as Box<dyn Fn(&mut RunRequest)>,
            "drop --fresh-install; or drop --installed-app to let QaReN install its development build",
        ),
        (
            "record",
            Box::new(|req: &mut RunRequest| req.record = true),
            "drop --record",
        ),
        (
            "android",
            Box::new(|req: &mut RunRequest| req.platform = Platform::Android),
            "run without --installed-app, or use --platform ios with a simulator",
        ),
    ] {
        let mut req = installed_request(&repo, &app);
        edit(&mut req);
        let mut mock = MockRunner::new();

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused, "{case}");
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::InstalledAppUnsupported, "{case}");
        assert_eq!(receipt.next_action, next, "{case}");
        assert!(
            !mock.calls.iter().any(|c| c.program == "xcrun"
                || c.program.ends_with("adb")
                || c.rendered().contains("simctl")),
            "{case}: {:?}",
            labels(&mock)
        );
    }
}

// Rewrites or removes the installed bundle's JavaScript just before the post-walk read.
fn change_before_second_read(mock: &mut MockRunner, js: PathBuf, remove: bool) {
    let mut reads = 0;
    mock.observe = Some(Box::new(move |spec: &CmdSpec| {
        if spec.label == "simctl-app-container" {
            reads += 1;
            if reads == 2 {
                if remove {
                    std::fs::remove_file(&js).unwrap();
                } else {
                    std::fs::write(&js, "replaced javascript").unwrap();
                }
            }
        }
    }));
}

#[test]
fn installed_app_fails_when_the_installed_javascript_changes_during_the_walk() {
    for remove in [false, true] {
        let (repo, app) = app_repo();
        let bundle = installed_bundle(&repo, Some("release javascript"));
        let mut mock = MockRunner::new();
        script_installed_preflight(&mut mock, &repo);
        script_installed_launch(&mut mock, &bundle);
        script_installed_walk(&mut mock, &pass_stdout(), 0, container(&bundle));
        change_before_second_read(&mut mock, bundle.join("main.jsbundle"), remove);

        let receipt = run(&mut mock, &installed_request(&repo, &app));

        assert_eq!(mock.remaining(), 0);
        let failure = receipt.failure.as_ref().unwrap();
        if remove {
            assert_eq!(failure.code, FailureCode::CandidateUnavailable);
            assert_eq!(
                failure.detail.as_str(),
                "the installed app could not be read after the walk"
            );
            assert_eq!(
                failure.next_action.as_str(),
                "check that the app is still installed on the simulator, then re-run"
            );
        } else {
            assert_eq!(receipt.result, ReceiptResult::Fail);
            assert_eq!(failure.code, FailureCode::CandidateDrifted);
            assert!(failure
                .detail
                .as_str()
                .contains("the installed app's JavaScript changed during the run"));
        }
    }
}

fn plant_simulator_owner(repo: &Path, borrowed: bool) -> qaren::lease::Lease {
    plant_holder(repo, |r| {
        r.resources.device_borrowed = borrowed;
        r.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
            udid: UDID.into(),
            name: "qa-company-app".into(),
            device_type: "iPhone 17".into(),
            runtime: "iOS 26.5".into(),
            ..Default::default()
        });
    })
}

fn deletes_or_stops_a_simulator(mock: &MockRunner) -> bool {
    mock.calls
        .iter()
        .any(|c| c.rendered().contains("simctl delete") || c.rendered().contains("simctl shutdown"))
}

#[test]
fn installed_app_never_reclaims_a_dead_run_that_created_its_simulator() {
    let (repo, app) = app_repo();
    let held = plant_simulator_owner(&repo, false);
    let mut mock = MockRunner::new();
    script_installed_preflight(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success(""));

    let receipt = run(&mut mock, &installed_request(&repo, &app));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert_eq!(
        failure.detail.as_str(),
        "the device lease is held by unfinished run check-earlier, which created this simulator; cleaning that run up can delete the simulator and every app on it"
    );
    assert_eq!(
        receipt.next_action,
        "use a simulator QaReN did not create; or run qaren cleanup check-earlier --json yourself if this simulator may be deleted"
    );
    assert!(!deletes_or_stops_a_simulator(&mock), "{:?}", labels(&mock));
    assert!(held.lock_dir.exists());
    assert_eq!(
        RunRecord::load(&repo.join("runs"), "check-earlier").unwrap().phase,
        Phase::Walking
    );
}

#[test]
fn without_the_flag_a_dead_simulator_owner_is_still_reclaimed_and_its_simulator_deleted() {
    let (repo, app) = app_repo();
    let held = plant_simulator_owner(&repo, false);
    let mut mock = MockRunner::new();
    script_preflight_until_lease(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success(""));
    mock.expect_run("simctl list devices -j", CmdOutput::success(&booted_json()));
    mock.expect_run("simctl shutdown", CmdOutput::success(""));
    mock.expect_run("simctl delete", CmdOutput::success(""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("simctl list devices -j", CmdOutput::success(&booted_json()));
    script_unknown_admission(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;

    let receipt = run(&mut mock, &req);

    assert_eq!(mock.remaining(), 0);
    assert!(deletes_or_stops_a_simulator(&mock), "{:?}", labels(&mock));
    assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
    assert!(!held.lock_dir.exists());
}

#[test]
fn installed_app_reclaims_a_dead_run_that_borrowed_its_simulator() {
    let (repo, app) = app_repo();
    let held = plant_simulator_owner(&repo, true);
    let mut mock = MockRunner::new();
    script_installed_preflight(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success(""));
    mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(""));
    mock.expect_run("simctl list devices -j", CmdOutput::success(&booted_json()));
    script_app_presence(&mut mock, false);

    let receipt = run(&mut mock, &installed_request(&repo, &app));

    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
    assert!(!deletes_or_stops_a_simulator(&mock), "{:?}", labels(&mock));
    assert!(!held.lock_dir.exists());
}

// The two preflight replies of a plan with no inputs; the inventory carries no login snapshot.
fn script_plan_without_login(mock: &mut MockRunner, repo: &Path) {
    mock.environment
        .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput::success(r#"{"ok":true,"inputProtocol":1,"requiredInputs":[]}"#),
    );
    let plan = std::fs::read(repo.join("test-app/plan.md")).unwrap();
    let output = private_preflight(serde_json::json!({"ok":true,"prepared":{
        "hash":qaren::candidate::sha256_hex(&plan),"blocks":[]
    },"jev":probe_json()}));
    mock.expect_run(
        "walk.js --preflight-stdin",
        CmdOutput::success(&output.to_string()),
    );
}

fn configure_login_block(app: &Path) {
    let config = app.join(".qaren/config.yaml");
    let mut yaml = std::fs::read_to_string(&config).unwrap();
    yaml.push_str("loginBlock: log-in\nloginMarker:\n  id: login-screen\n");
    std::fs::write(&config, yaml).unwrap();
}

#[test]
fn installed_app_drops_a_configured_login_block_before_its_inputs_are_read() {
    let (repo, app) = app_repo();
    configure_login_block(&app);
    let bundle = installed_bundle(&repo, Some("release javascript"));
    let mut mock = MockRunner::new();
    script_plan_without_login(&mut mock, &repo);
    script_installed_device(&mut mock, &repo);
    script_installed_launch(&mut mock, &bundle);
    script_installed_walk(&mut mock, &pass_stdout(), 0, container(&bundle));

    let receipt = run(&mut mock, &installed_request(&repo, &app));

    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(mock.remaining(), 0, "the login re-read did not run");
    let inventory: serde_json::Value = serde_json::from_slice(&mock.private_inputs[0]).unwrap();
    assert_eq!(inventory["phase"], "input-inventory");
    assert!(inventory.get("login").is_none(), "{inventory}");
    let payload = core_request_payload(&mock);
    for key in ["loginBlock", "loginMarker", "loginSnapshot"] {
        assert!(payload.get(key).is_none(), "{key}");
    }
    assert_eq!(
        receipt.outcomes["login_block"],
        "not replayed in installed-app mode"
    );
}

#[test]
fn without_the_flag_a_login_block_needs_its_snapshot_in_the_inventory() {
    let (repo, app) = app_repo();
    configure_login_block(&app);
    let mut mock = MockRunner::new();
    script_plan_without_login(&mut mock, &repo);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Refused, "{:?}", receipt.failure);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::CoreRefused);
    assert_eq!(failure.detail.as_str(), "runtime input admission refused");
    let inventory: serde_json::Value = serde_json::from_slice(&mock.private_inputs[0]).unwrap();
    assert!(inventory.get("login").is_some(), "{inventory}");
}
