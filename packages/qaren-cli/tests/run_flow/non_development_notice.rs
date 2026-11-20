use super::*;

const NOTICE: &str = "a non-development build of com.rndevagent.testapp was installed when this run started. A default run replaces the installed app with QaReN's development build; --fresh-install removes it first. To test an installed build as it is: qaren check --installed-app";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Found {
    Release,
    DevClient,
    JsDirectory,
    LookupFailed,
    LookupTimedOut,
}

// The container the probe reads: a temp directory, scripted as the lookup's stdout.
fn container(repo: &Path, found: Found) -> CmdOutput {
    let bundle = repo.join("installed").join(format!("{found:?}.app"));
    std::fs::create_dir_all(&bundle).unwrap();
    match found {
        Found::Release | Found::LookupFailed | Found::LookupTimedOut => {
            std::fs::write(bundle.join("main.jsbundle"), "release js").unwrap()
        }
        Found::JsDirectory => std::fs::create_dir_all(bundle.join("main.jsbundle")).unwrap(),
        Found::DevClient => {}
    }
    let stdout = format!("{}\n", bundle.display());
    match found {
        Found::LookupFailed => CmdOutput {
            stdout,
            ..CmdOutput::failed(1, "")
        },
        Found::LookupTimedOut => CmdOutput {
            stdout,
            timed_out: true,
            ..CmdOutput::default()
        },
        _ => CmdOutput::success(&stdout),
    }
}

// A workspace app whose verified build sits in the native cache, so a later default run reuses it.
fn seeded_workspace() -> (PathBuf, PathBuf) {
    let (repo, app) = app_repo();
    common::write_ios_workspace(&app, "ios/First.xcworkspace");
    configure_workspace(&app, "ios/First.xcworkspace", "Debug");
    let mut seed = MockRunner::new();
    script_preflight(&mut seed, &repo);
    seed.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_provision_build(&mut seed, "xcodebuild", common::IOS_NATIVE_FILES);
    script_drift_status(&mut seed);
    script_host_probe(&mut seed, UDID, hosts_absent());
    seed.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut seed);
    script_teardown(&mut seed);
    let mut req = request(&repo, &app, 30);
    req.runs_root = repo.join("runs-seed");
    assert_eq!(run(&mut seed, &req).result, ReceiptResult::Pass);
    (repo, app)
}

fn script_reuse_decision(mock: &mut MockRunner) {
    mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
    common::script_xcode(mock);
}

fn script_reuse_pass(mock: &mut MockRunner) {
    script_reuse_decision(mock);
    script_check_install_and_launch(mock);
    script_ready_recheck(mock, common::IOS_NATIVE_FILES);
    script_drift_status(mock);
    script_host_probe(mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(mock);
    script_teardown(mock);
}

fn assert_probe_precedes_install_and_uninstall(mock: &MockRunner) {
    let rendered: Vec<String> = mock.calls.iter().map(|c| c.rendered()).collect();
    let probe = rendered
        .iter()
        .position(|c| c.contains("simctl get_app_container"))
        .expect("the probe ran");
    assert!(
        !rendered[..probe]
            .iter()
            .any(|c| c.contains("simctl install") || c.contains("simctl uninstall")),
        "{rendered:#?}"
    );
}

#[test]
fn a_default_run_names_a_non_development_build_it_finds_before_it_replaces_it() {
    let (repo, app) = seeded_workspace();
    for (index, (found, fresh)) in [
        (Found::Release, false),
        (Found::Release, true),
        (Found::DevClient, false),
        (Found::JsDirectory, false),
        (Found::LookupFailed, false),
        (Found::LookupTimedOut, false),
    ]
    .into_iter()
    .enumerate()
    {
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        if fresh {
            script_admission(&mut mock);
        }
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        if fresh {
            script_admission(&mut mock);
        }
        mock.expect_run(
            &format!("simctl get_app_container {UDID} com.rndevagent.testapp app"),
            container(&repo, found),
        );
        if fresh {
            script_app_presence(&mut mock, true);
            mock.expect_run(
                &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                CmdOutput::success(""),
            );
            script_app_presence(&mut mock, false);
        }
        script_reuse_pass(&mut mock);
        let mut req = request(&repo, &app, 30);
        req.runs_root = repo.join(format!("runs-{index}"));
        req.fresh_install = fresh;

        let receipt = run(&mut mock, &req);

        assert_eq!(
            receipt.result,
            ReceiptResult::Pass,
            "{found:?}: {:?}",
            receipt.failure
        );
        assert_eq!(
            receipt.build.as_ref().unwrap().decision,
            qaren::buildplan::BuildDecision::Reuse
        );
        assert_eq!(mock.remaining(), 0, "{found:?}");
        assert_probe_precedes_install_and_uninstall(&mock);
        let note = receipt.outcomes.get("non_development_app_installed");
        if found == Found::Release {
            assert_eq!(note.map(String::as_str), Some(NOTICE), "fresh={fresh}");
        } else {
            assert_eq!(note, None, "{found:?}");
        }
    }
}

#[test]
fn the_notice_reaches_the_receipt_when_the_cached_install_fails() {
    let (repo, app) = seeded_workspace();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("simctl get_app_container", container(&repo, Found::Release));
    script_reuse_decision(&mut mock);
    common::script_ios_app_verification(&mut mock);
    common::script_ios_metro_spawn(&mut mock);
    script_check_inventory(&mut mock);
    mock.expect_run("simctl install", CmdOutput::failed(1, "install refused"));
    common::script_ios_metro_cleanup(&mut mock);
    let mut req = request(&repo, &app, 30);
    req.runs_root = repo.join("runs-install-fails");

    let receipt = run(&mut mock, &req);

    assert_ne!(receipt.result, ReceiptResult::Pass);
    assert_eq!(mock.remaining(), 0);
    assert_probe_precedes_install_and_uninstall(&mock);
    assert_eq!(
        receipt
            .outcomes
            .get("non_development_app_installed")
            .map(String::as_str),
        Some(NOTICE)
    );
}

#[test]
fn the_notice_reaches_the_receipt_when_a_new_build_fails_before_any_install() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    common::script_ios_deps(&mut mock);
    mock.expect_run("simctl get_app_container", container(&repo, Found::Release));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_clean_build_plan(&mut mock);
    mock.expect_spawn_piped("expo run:ios", 5000, "", Some(65));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!mock
        .calls
        .iter()
        .any(|c| matches!(c.label.as_str(), "simctl-install" | "simctl-uninstall")));
    assert_eq!(
        receipt
            .outcomes
            .get("non_development_app_installed")
            .map(String::as_str),
        Some(NOTICE)
    );
}
