mod common;

use qaren::candidate::{resolve, verify_unchanged_with};
use qaren::exec::{CmdSpec, RealRunner, Runner};
use std::path::Path;

fn git(repo: &Path, args: &[&str]) {
    let output = RealRunner::new().run(&CmdSpec::new("git", "git", args, 20).cwd(repo));
    assert!(output.ok(), "{}", output.summary());
}

fn check_integration_drift(extra_path: Option<&str>, tracked: bool) -> bool {
    let repo = common::temp_repo();
    let write = |path: &str, contents: &str| {
        let path = repo.join("test-app").join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    };
    if tracked {
        write(extra_path.unwrap(), "original\n");
    }
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "baseline",
        ],
    );
    let scenario = common::scenario_from(
        "schema: qaren/1\nname: drift\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: iPhone\n  runtime: iOS\n",
    );
    let mut runner = RealRunner::new();
    let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    assert!(!baseline.git_dirty);
    write(".qaren/integration/rn-session-adapter.cjs", "integration\n");
    assert!(verify_unchanged_with(&mut runner, &baseline, true).is_ok());
    let integrated_baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    assert_eq!(
        baseline.worktree_fingerprint,
        integrated_baseline.worktree_fingerprint
    );
    write(".qaren/integration/rn-session-metro.cjs", "integration\n");
    if let Some(path) = extra_path {
        write(path, "changed\n");
    }
    let result = verify_unchanged_with(&mut runner, &integrated_baseline, true);
    std::fs::remove_dir_all(&repo).unwrap();
    println!("{extra_path:?} (tracked={tracked}): {result:?}");
    result.is_ok()
}

#[test]
fn integration_and_saved_actions_are_tolerated_in_a_real_checkout() {
    let accepted = [
        check_integration_drift(None, false),
        check_integration_drift(Some(".qaren/actions/new-flow.yaml"), false),
        check_integration_drift(Some(".qaren/config.yaml"), false),
        check_integration_drift(Some(".qaren/actions/existing.yaml"), true),
        check_integration_drift(Some(".qaren/actions/new-flow.yml"), false),
        check_integration_drift(Some(".qaren/actions/existing.yml"), true),
        check_integration_drift(Some(".qaren/actions/source.ts"), false),
        check_integration_drift(Some("App.tsx"), true),
    ];
    assert_eq!(
        accepted,
        [true, true, false, true, true, true, false, false]
    );
}

#[test]
fn phrase_named_files_preserve_native_fingerprints_and_drift_detection() {
    for tracked in [true, false] {
        let repo = common::temp_repo();
        let project = repo.join("test-app");
        std::fs::write(project.join("app.json"), r#"{"expo":{"name":"before"}}"#).unwrap();
        std::fs::create_dir_all(project.join("ios")).unwrap();
        std::fs::write(project.join("ios/Podfile"), "platform :ios, '15.0'\n").unwrap();
        let notes = project.join("private key notes.txt");
        if tracked {
            std::fs::write(&notes, "notes").unwrap();
        }
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        if !tracked {
            std::fs::write(&notes, "notes").unwrap();
        }
        let scenario = common::scenario_from(&common::ios_scenario_yaml(8793));
        let mut runner = RealRunner::new();
        let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
        // Only the host's Xcode availability may leave a real iOS fingerprint incomplete here.
        let complete_but_toolchain = |fp: &qaren::fingerprint::NativeFingerprint| {
            fp.incompleteness
                .iter()
                .all(|reason| reason.starts_with("toolchain identity unavailable"))
        };
        let before = qaren::fingerprint::compute(&mut runner, &repo, &project, "ios").unwrap();
        assert!(
            complete_but_toolchain(&before),
            "{:?}",
            before.incompleteness
        );
        assert!(before.native_dir_in_candidate);
        assert!(before.file_count >= 2);
        assert!(verify_unchanged_with(&mut runner, &baseline, false).is_ok());
        std::fs::write(project.join("app.json"), r#"{"expo":{"name":"after"}}"#).unwrap();
        let after = qaren::fingerprint::compute(&mut runner, &repo, &project, "ios").unwrap();
        assert_ne!(before.value, after.value, "tracked={tracked}");
        assert!(complete_but_toolchain(&after), "{:?}", after.incompleteness);
        let changed = resolve(&mut runner, &scenario, &repo).unwrap();
        assert_ne!(
            baseline.worktree_fingerprint, changed.worktree_fingerprint,
            "tracked={tracked}"
        );
        assert!(verify_unchanged_with(&mut runner, &baseline, false).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }
}

struct InstallMutation {
    inner: RealRunner,
    path: std::path::PathBuf,
}

impl Runner for InstallMutation {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> qaren::exec::CmdOutput {
        match spec.label.as_str() {
            "pnpm-fetch" => qaren::exec::CmdOutput::success("fetched"),
            "pnpm-install" => {
                std::fs::write(&self.path, "changed during install").unwrap();
                qaren::exec::CmdOutput::success("installed")
            }
            _ => self.inner.execute(spec, interruptible),
        }
    }
    fn spawn_group_unchecked(
        &mut self,
        _: &CmdSpec,
        _: &Path,
    ) -> std::io::Result<qaren::exec::Spawned> {
        unreachable!()
    }
    fn spawn_piped_unchecked(
        &mut self,
        _: &CmdSpec,
        _: &Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        unreachable!()
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.inner.sleep(d);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}

#[test]
fn same_status_dirty_and_untracked_content_changes_during_install_are_rejected() {
    use qaren::commands::prewarm::{prewarm, PrewarmArgs};
    for tracked in [true, false] {
        let repo = common::temp_repo();
        let file = repo.join("test-app/App.tsx");
        let scenario_path = repo.join("scenario.yaml");
        std::fs::write(&scenario_path, common::ios_scenario_yaml(8793)).unwrap();
        if tracked {
            std::fs::write(&file, "original").unwrap();
        }
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "."]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(&file, "dirty before install").unwrap();
        let status = CmdSpec::new(
            "git-status",
            "git",
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            20,
        )
        .cwd(&repo);
        let before = RealRunner::new().run(&status).stdout;
        let scenario = common::scenario_from(&common::ios_scenario_yaml(8793));
        let baseline = resolve(&mut RealRunner::new(), &scenario, &repo).unwrap();
        assert!(verify_unchanged_with(&mut RealRunner::new(), &baseline, false).is_ok());
        let mut runner = InstallMutation {
            inner: RealRunner::new(),
            path: file,
        };
        let receipt = prewarm(&mut runner, &PrewarmArgs { scenario_path });
        assert_eq!(before, RealRunner::new().run(&status).stdout);
        assert_eq!(
            receipt.failure.unwrap().code,
            qaren::failure::FailureCode::CandidateDrifted
        );
        assert!(verify_unchanged_with(&mut RealRunner::new(), &baseline, false).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }
}
