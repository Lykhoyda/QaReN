use super::*;
use qaren::buildplan::{self, BuildDecision, NativeCacheState, StateStatus};

const FILES: &str = "test-app/app.config.ts\0";
const CONFIG: &str = "export default () => ({ extra: { flavor: process.env.FLAVOR } });\n";
const CANARY: &str = "private-config-failure-canary";

#[derive(Clone, Copy)]
enum Evaluation {
    Hashes(&'static str, &'static str),
    Unavailable,
}
const STABLE: Evaluation = Evaluation::Hashes("aaaa", "bbbb");

fn dynamic_app() -> (PathBuf, PathBuf) {
    let (repo, app) = app_repo();
    std::fs::write(app.join("app.config.ts"), CONFIG).unwrap();
    (repo, app)
}

fn script_fingerprint(mock: &mut MockRunner, evaluation: Evaluation) {
    mock.expect_run("ls-files", CmdOutput::success(FILES));
    mock.expect_run(
        "require.resolve",
        CmdOutput::success(common::EXPO_FINGERPRINT_CLI),
    );
    let (expo, ci) = match evaluation {
        Evaluation::Hashes(expo, ci) => (expo, ci),
        Evaluation::Unavailable => ("aaaa", "bbbb"),
    };
    for (index, hash) in [expo, ci].into_iter().enumerate() {
        let output = if index == 0 && matches!(evaluation, Evaluation::Unavailable) {
            CmdOutput::failed(1, CANARY)
        } else {
            CmdOutput::success(
                &serde_json::json!({
                    "hash": hash,
                    "sources": [{"type":"contents", "id":"expoConfig", "contents":CANARY}]
                })
                .to_string(),
            )
        };
        mock.expect_run("fingerprint:generate", output);
    }
}

fn script_prepare(
    mock: &mut MockRunner,
    repo: &Path,
    app: &Path,
    evaluation: Evaluation,
    build: bool,
) {
    script_android_preflight(mock, repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_fingerprint(mock, evaluation);
    if build {
        if app.join("android").exists() {
            mock.expect_run(PREBUILD, CmdOutput::success(""));
        } else {
            mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
            script_android_finite_build(mock, PREBUILD, 5000, 0);
        }
        script_android_finite_build(mock, GRADLE, 5001, 0);
    }
    script_android_launch(mock, 0);
    script_android_app_tick(mock, CmdOutput::success("4242\n"));
}

fn script_walk(mock: &mut MockRunner) {
    script_drift_status(mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(mock);
    script_drift_status(mock);
    mock.expect_run("git", CmdOutput::success(&"b".repeat(40)));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/config.yaml\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    script_metro_teardown(mock, EMULATOR, None);
    script_borrowed_release(mock, false);
}

fn script_failed_ready_teardown(mock: &mut MockRunner) {
    script_metro_teardown(mock, EMULATOR, None);
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run("reverse --list", CmdOutput::success(""));
}

fn state(repo: &Path) -> NativeCacheState {
    match buildplan::load_state(repo, "android", "com.rndevagent.testapp") {
        StateStatus::Loaded(state) => *state,
        other => panic!("expected recorded build: {other:?}"),
    }
}

fn seed_build(
    repo: &Path,
    app: &Path,
    req: &RunRequest,
    plan: Evaluation,
    recheck: Evaluation,
) -> qaren::receipt::Receipt {
    let mut mock = android_mock();
    script_prepare(&mut mock, repo, app, plan, true);
    script_fingerprint(&mut mock, recheck);
    script_walk(&mut mock);
    let receipt = run(&mut mock, req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{}", receipt.to_json());
    assert_eq!(mock.remaining(), 0);
    assert!(!receipt.to_json().contains(CANARY));
    receipt
}

#[test]
fn dynamic_android_build_is_reused_then_a_ci_config_change_rebuilds() {
    let (repo, app) = dynamic_app();
    let mut req = android_request(&repo, &app);
    seed_build(&repo, &app, &req, STABLE, STABLE);
    assert_eq!(state(&repo).fingerprint_parts["expo-ci"], "expo:bbbb");

    req.runs_root = repo.join("runs-2");
    let mut mock = android_mock();
    script_prepare(&mut mock, &repo, &app, STABLE, false);
    script_fingerprint(&mut mock, STABLE);
    script_walk(&mut mock);
    let second = run(&mut mock, &req);
    assert_eq!(second.result, ReceiptResult::Pass, "{}", second.to_json());
    assert_eq!(
        second.build.as_ref().unwrap().decision,
        BuildDecision::Reuse
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock)
        .iter()
        .any(|label| label == "expo-prebuild" || label == "gradle-assemble"));
    assert_eq!(
        labels(&mock)
            .iter()
            .filter(|label| *label == "adb-install")
            .count(),
        1
    );

    req.runs_root = repo.join("runs-3");
    let changed = Evaluation::Hashes("aaaa", "cccc");
    let third = seed_build(&repo, &app, &req, changed, changed);
    let plan = third.build.unwrap();
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(
        plan.evidence
            .iter()
            .any(|line| line.contains("native inputs changed: expo-ci")),
        "{:?}",
        plan.evidence
    );
}

#[test]
fn dynamic_android_upgrade_from_a_manifest_only_build_regenerates() {
    let (repo, app) = dynamic_app();
    let mut req = android_request(&repo, &app);
    // This is the state shape written before evaluated Android config was bound.
    seed_build(
        &repo,
        &app,
        &req,
        Evaluation::Unavailable,
        Evaluation::Unavailable,
    );
    let recorded = state(&repo);
    assert_eq!(
        recorded.fingerprint_parts.keys().collect::<Vec<_>>(),
        ["rnfp"]
    );
    assert_eq!(recorded.generated_native_dirs, ["android"]);
    req.runs_root = repo.join("runs-upgrade");
    let receipt = seed_build(&repo, &app, &req, STABLE, STABLE);
    let plan = receipt.build.unwrap();
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(
        plan.reason
            .contains("the recorded build has no value for expo"),
        "{}",
        plan.reason
    );
}

#[test]
fn dynamic_android_late_evaluation_keeps_the_plan_time_build_identity() {
    let (repo, app) = dynamic_app();
    let mut req = android_request(&repo, &app);
    let first = seed_build(&repo, &app, &req, Evaluation::Unavailable, STABLE);
    let recorded = state(&repo);
    assert_eq!(recorded.fingerprint, first.build.unwrap().fingerprint);
    assert_eq!(recorded.fingerprint, recorded.fingerprint_parts["rnfp"]);
    assert_eq!(
        recorded.fingerprint_parts.keys().collect::<Vec<_>>(),
        ["rnfp"]
    );
    assert_eq!(first.outcomes["fingerprint_complete"], "false");
    req.runs_root = repo.join("runs-late");
    let next = seed_build(&repo, &app, &req, STABLE, STABLE);
    assert_eq!(next.build.unwrap().decision, BuildDecision::Clean);
}

#[test]
fn dynamic_android_recheck_recovers_one_unavailable_evaluation() {
    let (repo, app) = dynamic_app();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_prepare(&mut mock, &repo, &app, STABLE, true);
    script_fingerprint(&mut mock, Evaluation::Unavailable);
    script_fingerprint(&mut mock, STABLE);
    script_walk(&mut mock);
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{}", receipt.to_json());
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        mock.calls
            .iter()
            .filter(|c| c.label == "expo-fingerprint" || c.label == "expo-fingerprint-ci")
            .count(),
        6
    );
    assert_eq!(state(&repo).fingerprint_parts["expo"], "expo:aaaa");
}

// A phone run that builds for arm64-v8a, up to the recheck.
fn script_phone_prepare(mock: &mut MockRunner, repo: &Path, app: &Path) {
    android_until_borrow(repo, mock);
    script_phone_borrow(mock, PHONE_BESIDE_OFFLINE_EMULATOR);
    script_android_after_borrow(mock, repo);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    script_fingerprint(mock, STABLE);
    if app.join("android").exists() {
        mock.expect_run(PREBUILD, CmdOutput::success(""));
    } else {
        mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
        script_android_finite_build(mock, PREBUILD, 5000, 0);
    }
    script_android_finite_build(mock, GRADLE_ARM64, 5001, 0);
    script_android_launch(mock, 0);
    script_android_app_tick(mock, CmdOutput::success("4242\n"));
}

// The phone's ABI is in the planned fingerprint, so the recheck, also after one failed evaluation,
// must add it too; without it an unchanged app is refused as changed.
#[test]
fn dynamic_android_phone_build_passes_the_recheck_with_its_abi() {
    for recheck in [&[STABLE][..], &[Evaluation::Unavailable, STABLE]] {
        let (repo, app) = dynamic_app();
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        script_phone_prepare(&mut mock, &repo, &app);
        for evaluation in recheck {
            script_fingerprint(&mut mock, *evaluation);
        }
        script_walk(&mut mock);
        the_two_runner_packages_are_removed(&mut mock);

        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Pass, "{}", receipt.to_json());
        assert_eq!(mock.remaining(), 0);
        assert_eq!(
            receipt.device.as_ref().unwrap().usb_serial.as_deref(),
            Some(PHONE)
        );
    }
}

#[test]
fn dynamic_android_reused_build_refuses_repeated_evaluation_failure_without_rewriting_state() {
    let (repo, app) = dynamic_app();
    let mut req = android_request(&repo, &app);
    seed_build(&repo, &app, &req, STABLE, STABLE);
    let path = buildplan::state_path(&repo, "android", "com.rndevagent.testapp");
    let before = std::fs::read(&path).unwrap();
    req.runs_root = repo.join("runs-refused");
    let mut mock = android_mock();
    script_prepare(&mut mock, &repo, &app, STABLE, false);
    script_fingerprint(&mut mock, Evaluation::Unavailable);
    script_fingerprint(&mut mock, Evaluation::Unavailable);
    script_failed_ready_teardown(&mut mock);
    let receipt = run(&mut mock, &req);
    let failure = receipt
        .failure
        .as_ref()
        .expect("evaluation failure must fail the run");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(
        failure
            .detail
            .contains("app config could not be evaluated again after the build"),
        "{}",
        failure.detail
    );
    assert!(failure
        .detail
        .contains("expo: @expo/fingerprint fingerprint:generate did not complete (exit 1)"));
    assert!(!failure.detail.contains("native inputs changed"));
    assert!(!receipt.to_json().contains(CANARY));
    assert_eq!(receipt.build.unwrap().decision, BuildDecision::Reuse);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn dynamic_android_recheck_names_changed_native_parts() {
    for part in ["rnfp", "expo"] {
        let (repo, app) = dynamic_app();
        let req = android_request(&repo, &app);
        let mut mock = android_mock();
        script_prepare(&mut mock, &repo, &app, STABLE, true);
        if part == "rnfp" {
            let path = app.join("app.config.ts");
            mock.observe = Some(Box::new(move |spec| {
                if spec.label == "adb-install" {
                    std::fs::write(&path, format!("{CONFIG}// changed\n")).unwrap();
                }
            }));
        }
        script_fingerprint(
            &mut mock,
            if part == "expo" {
                Evaluation::Hashes("cccc", "bbbb")
            } else {
                STABLE
            },
        );
        script_failed_ready_teardown(&mut mock);
        let receipt = run(&mut mock, &req);
        let failure = receipt
            .failure
            .as_ref()
            .expect("changed native inputs must fail");
        assert_eq!(failure.code, FailureCode::CandidateDrifted);
        assert!(failure.detail.contains("native inputs changed"));
        assert!(failure.detail.contains(part), "{}", failure.detail);
        assert_eq!(mock.remaining(), 0);
        assert!(!buildplan::state_path(&repo, "android", "com.rndevagent.testapp").exists());
    }
}

#[test]
fn android_manifest_drift_during_preparation_still_refuses() {
    let (repo, app) = app_repo();
    let path = app.join("app.json");
    std::fs::write(&path, "{}").unwrap();
    let req = android_request(&repo, &app);
    let mut mock = android_mock();
    script_android_preflight(&mut mock, &repo, ONE_EMULATOR, EMULATOR);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success("test-app/app.json\0"));
    mock.expect_run("check-ignore -q android/", CmdOutput::success(""));
    script_android_finite_build(&mut mock, PREBUILD, 5000, 0);
    script_android_finite_build(&mut mock, GRADLE, 5001, 0);
    script_android_launch(&mut mock, 0);
    script_android_app_tick(&mut mock, CmdOutput::success("4242\n"));
    mock.expect_run("ls-files", CmdOutput::success("test-app/app.json\0"));
    mock.observe = Some(Box::new(move |spec| {
        if spec.label == "adb-install" {
            std::fs::write(&path, r#"{"expo":{"name":"changed"}}"#).unwrap();
        }
    }));
    script_failed_ready_teardown(&mut mock);
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::CandidateDrifted);
    assert_eq!(mock.remaining(), 0);
    assert!(!buildplan::state_path(&repo, "android", "com.rndevagent.testapp").exists());
}

// Same app, same Expo config: the emulator's build is never reused on the phone, whose ABI is in
// the fingerprint value.
#[test]
fn dynamic_android_phone_never_reuses_an_emulator_build() {
    let (repo, app) = dynamic_app();
    let mut req = android_request(&repo, &app);
    seed_build(&repo, &app, &req, STABLE, STABLE);
    req.runs_root = repo.join("runs-phone");
    let mut mock = android_mock();
    script_phone_prepare(&mut mock, &repo, &app);
    script_fingerprint(&mut mock, STABLE);
    script_walk(&mut mock);
    the_two_runner_packages_are_removed(&mut mock);

    let receipt = run(&mut mock, &req);

    assert_eq!(receipt.result, ReceiptResult::Pass, "{}", receipt.to_json());
    assert_eq!(mock.remaining(), 0);
    assert_ne!(
        receipt.build.as_ref().unwrap().decision,
        BuildDecision::Reuse
    );
}
