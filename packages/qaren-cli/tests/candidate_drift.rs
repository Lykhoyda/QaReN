mod common;

use qaren::candidate::{resolve, verify_unchanged_with, worktree_fingerprint, CandidateCheck};
use qaren::exec::{CmdOutput, CmdSpec, MockRunner, RealRunner, Runner};
use std::path::Path;

fn git(repo: &Path, args: &[&str]) {
    let output = RealRunner::new().run(&CmdSpec::new("git", "git", args, 20).cwd(repo));
    assert!(output.ok(), "{}", output.summary());
}

#[test]
fn watchman_cookies_do_not_change_candidate_cleanliness_or_fingerprints() {
    for (before, after, edit, expected_error) in [
        ("", "?? .watchman-cookie-host-123-4\0", false, None),
        ("?? .watchman-cookie-host-123-4\0", "", false, None),
        (
            "",
            "?? .watchman-cookie-host-123-4\0 M test-app/App.tsx\0",
            false,
            Some("cleanliness changed"),
        ),
        (
            " M test-app/App.tsx\0",
            " M test-app/App.tsx\0?? test-app/.watchman-cookie-host-123-4\0",
            false,
            None,
        ),
        (
            " M test-app/App.tsx\0",
            " M test-app/App.tsx\0?? test-app/.watchman-cookie-host-123-4\0",
            true,
            Some("contents changed"),
        ),
    ] {
        let repo = common::temp_repo();
        let app_file = repo.join("test-app/App.tsx");
        std::fs::write(&app_file, "before").unwrap();
        let scenario = common::scenario_from(&common::ios_scenario_yaml(8793));
        let mut runner = MockRunner::new();
        runner.expect_run("git", CmdOutput::success(&repo.to_string_lossy()));
        runner.expect_run("git", CmdOutput::success("abc"));
        runner.expect_run("git", CmdOutput::success(before));
        let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
        assert_eq!(baseline.git_dirty, before.contains("App.tsx"));
        if !baseline.git_dirty {
            assert_eq!(
                baseline.worktree_fingerprint,
                Some(worktree_fingerprint(&repo, "").unwrap())
            );
        }
        if edit {
            std::fs::write(app_file, "after").unwrap();
        }
        runner.expect_run("git", CmdOutput::success("abc"));
        runner.expect_run("git", CmdOutput::success(after));
        let result = verify_unchanged_with(&mut runner, &baseline, false);
        match expected_error {
            Some(expected) => assert!(
                matches!(&result, Err(CandidateCheck::Drifted(detail)) if detail.contains(expected)),
                "{result:?}"
            ),
            None => assert!(result.is_ok(), "{result:?}"),
        }
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(repo).unwrap();
    }
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

fn mock_baseline(status: &str) -> (std::path::PathBuf, qaren::candidate::Candidate) {
    mock_baseline_with(status, |_| {})
}

fn git_spawn_failure() -> CmdOutput {
    CmdOutput {
        exit_code: None,
        stderr: "No such file or directory (os error 2)".into(),
        ..Default::default()
    }
}

fn git_timeout() -> CmdOutput {
    CmdOutput {
        timed_out: true,
        ..Default::default()
    }
}

fn assert_unreadable(result: Result<(), CandidateCheck>, expected: &str) {
    assert!(
        matches!(&result, Err(CandidateCheck::Unreadable(detail)) if detail.contains(expected)),
        "{result:?}"
    );
}

#[test]
fn a_failed_git_read_is_unreadable_never_drift() {
    let not_a_repo = || {
        CmdOutput::failed(
            128,
            "fatal: not a git repository (or any of the parent directories): .git",
        )
    };
    for head in [not_a_repo(), git_timeout(), git_spawn_failure()] {
        let (repo, baseline) = mock_baseline("");
        let mut runner = MockRunner::new();
        runner.expect_run("git", head);
        assert_unreadable(
            verify_unchanged_with(&mut runner, &baseline, false),
            "git rev-parse HEAD failed",
        );
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(repo).unwrap();
    }
    for status in [
        not_a_repo(),
        CmdOutput::failed(128, "fatal: cannot open '.git/index': Permission denied"),
        CmdOutput::failed(128, "fatal: index file corrupt"),
        git_timeout(),
        git_spawn_failure(),
    ] {
        let (repo, baseline) = mock_baseline("");
        let mut runner = MockRunner::new();
        runner.expect_run("git", CmdOutput::success("abc"));
        runner.expect_run("git", status);
        assert_unreadable(
            verify_unchanged_with(&mut runner, &baseline, true),
            "git status --porcelain=v1 -z failed",
        );
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(repo).unwrap();
    }
}

#[test]
fn a_missing_repository_or_project_root_is_unreadable_without_running_git() {
    for (missing, expected) in [("", "repository root"), ("test-app", "project root")] {
        let (repo, baseline) = mock_baseline("");
        std::fs::remove_dir_all(repo.join(missing)).unwrap();
        let mut runner = MockRunner::new();
        assert_unreadable(
            verify_unchanged_with(&mut runner, &baseline, true),
            expected,
        );
        assert!(runner.calls.is_empty(), "no git call may run");
        let _ = std::fs::remove_dir_all(repo);
    }
}

#[test]
fn an_integration_filter_read_failure_is_unreadable_not_a_cleanliness_flip() {
    let modified = " M test-app/package.json\0";
    // git show HEAD:<path> fails.
    let (repo, baseline) = mock_baseline("");
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(modified));
    runner.expect_run("git", CmdOutput::failed(128, "fatal: bad object HEAD"));
    assert_unreadable(
        verify_unchanged_with(&mut runner, &baseline, true),
        "git show HEAD:test-app/package.json failed",
    );
    assert_eq!(runner.remaining(), 0);
    std::fs::remove_dir_all(repo).unwrap();

    // The tracked-identity git read fails after an integration-only delta.
    let (repo, baseline) = mock_baseline("");
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(modified));
    runner.expect_run("git", CmdOutput::success("{}"));
    runner.expect_run(
        "ls-tree",
        CmdOutput::failed(128, "fatal: not a git repository"),
    );
    runner.expect_run("ls-files", CmdOutput::success(""));
    assert_unreadable(
        verify_unchanged_with(&mut runner, &baseline, true),
        "git ls-tree HEAD failed",
    );
    assert_eq!(runner.remaining(), 0);
    std::fs::remove_dir_all(repo).unwrap();

    // The working file cannot be read.
    let (repo, baseline) = mock_baseline("");
    std::fs::remove_file(repo.join("test-app/package.json")).unwrap();
    std::fs::create_dir(repo.join("test-app/package.json")).unwrap();
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(modified));
    runner.expect_run("git", CmdOutput::success("{}"));
    assert_unreadable(
        verify_unchanged_with(&mut runner, &baseline, true),
        "cannot read test-app/package.json",
    );
    assert_eq!(runner.remaining(), 0);
    std::fs::remove_dir_all(repo).unwrap();

    // A readable but non-integration delta stays a cleanliness flip.
    let (repo, baseline) = mock_baseline("");
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(modified));
    runner.expect_run("git", CmdOutput::success("{\"name\":\"other\"}"));
    let result = verify_unchanged_with(&mut runner, &baseline, true);
    assert!(
        matches!(&result, Err(CandidateCheck::Drifted(d)) if d.contains("cleanliness changed")),
        "{result:?}"
    );
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn readable_changes_stay_drift_and_unchanged_deletions_and_renames_verify() {
    let (repo, baseline) = mock_baseline("");
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("def"));
    let result = verify_unchanged_with(&mut runner, &baseline, false);
    assert!(
        matches!(&result, Err(CandidateCheck::Drifted(d)) if d.contains("HEAD moved")),
        "{result:?}"
    );
    std::fs::remove_dir_all(repo).unwrap();

    let dirty = " D test-app/gone.ts\0R  test-app/new.ts\0test-app/old.ts\0";
    let (repo, baseline) = mock_baseline_with(dirty, |repo| {
        std::fs::write(repo.join("test-app/new.ts"), "renamed").unwrap();
    });
    assert!(baseline.git_dirty);
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(dirty));
    let result = verify_unchanged_with(&mut runner, &baseline, false);
    assert!(result.is_ok(), "{result:?}");
    std::fs::write(repo.join("test-app/new.ts"), "edited").unwrap();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(dirty));
    let result = verify_unchanged_with(&mut runner, &baseline, false);
    assert!(
        matches!(&result, Err(CandidateCheck::Drifted(d)) if d.contains("contents changed")),
        "{result:?}"
    );
    std::fs::remove_dir_all(repo).unwrap();
}

fn mock_baseline_with(
    status: &str,
    prepare: impl FnOnce(&Path),
) -> (std::path::PathBuf, qaren::candidate::Candidate) {
    let repo = common::temp_repo();
    prepare(&repo);
    let scenario = common::scenario_from(&common::ios_scenario_yaml(8793));
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success(&repo.to_string_lossy()));
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(status));
    let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    (repo, baseline)
}

#[test]
fn a_deleted_lockfile_is_drift_but_an_unreadable_lockfile_is_unreadable() {
    let lockfile = |repo: &Path| repo.join("test-app/pnpm-lock.yaml");
    // The deletion shows in git status first: a cleanliness flip.
    let (repo, baseline) = mock_baseline("");
    std::fs::remove_file(lockfile(&repo)).unwrap();
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(" D test-app/pnpm-lock.yaml\0"));
    let result = verify_unchanged_with(&mut runner, &baseline, false);
    assert!(
        matches!(&result, Err(CandidateCheck::Drifted(d)) if d.contains("cleanliness changed")),
        "{result:?}"
    );
    // An ignored lockfile's deletion reaches the byte comparison: still drift.
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(""));
    assert_eq!(
        verify_unchanged_with(&mut runner, &baseline, false),
        Err(CandidateCheck::Drifted("pnpm-lock.yaml changed".into()))
    );
    std::fs::remove_dir_all(repo).unwrap();

    let (repo, baseline) = mock_baseline("");
    std::fs::remove_file(lockfile(&repo)).unwrap();
    std::fs::create_dir(lockfile(&repo)).unwrap();
    let mut runner = MockRunner::new();
    runner.expect_run("git", CmdOutput::success("abc"));
    runner.expect_run("git", CmdOutput::success(""));
    assert_unreadable(
        verify_unchanged_with(&mut runner, &baseline, false),
        "cannot read pnpm-lock.yaml",
    );
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn a_real_checkout_whose_path_or_repository_vanishes_is_unreadable_but_a_new_commit_is_drift() {
    let repo = common::temp_repo();
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    let commit = |message: &str| {
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
                "-q",
                "--allow-empty",
                "-m",
                message,
            ],
        )
    };
    commit("baseline");
    let scenario = common::scenario_from(
        "schema: qaren/1\nname: vanish\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: iPhone\n  runtime: iOS\n",
    );
    let mut runner = RealRunner::new();
    let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    assert!(verify_unchanged_with(&mut runner, &baseline, true).is_ok());

    let unmounted = repo.with_extension("unmounted");
    std::fs::rename(&repo, &unmounted).unwrap();
    let result = verify_unchanged_with(&mut runner, &baseline, true);
    std::fs::rename(&unmounted, &repo).unwrap();
    println!("path vanished: {result:?}");
    assert!(
        matches!(&result, Err(CandidateCheck::Unreadable(d)) if d.contains("repository root")),
        "{result:?}"
    );

    std::fs::rename(repo.join(".git"), repo.join(".git-gone")).unwrap();
    let result = verify_unchanged_with(&mut runner, &baseline, true);
    std::fs::rename(repo.join(".git-gone"), repo.join(".git")).unwrap();
    println!("repository vanished: {result:?}");
    assert!(
        matches!(&result, Err(CandidateCheck::Unreadable(d)) if d.contains("git rev-parse HEAD failed")),
        "{result:?}"
    );

    assert!(verify_unchanged_with(&mut runner, &baseline, true).is_ok());
    commit("moved");
    let result = verify_unchanged_with(&mut runner, &baseline, true);
    println!("new commit: {result:?}");
    assert!(
        matches!(&result, Err(CandidateCheck::Drifted(d)) if d.contains("HEAD moved")),
        "{result:?}"
    );
    std::fs::remove_dir_all(&repo).unwrap();
}
