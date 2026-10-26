mod common;

use qaren::exec::{CmdOutput, CmdSpec, MockRunner, PipedChild, Runner, Spawned};
use qaren::publish::{publish, PrRunRecord, Publication};
use qaren::receipt::ReceiptResult;
use qaren::record::{VideoPublication, VideoStatus};
use qaren::redact::MachineIdentity;
use qaren::runrecord::{FinalVerification, TerminalResult};
use std::path::{Path, PathBuf};

const RUN: &str = "check-20261002T101500Z-000001";
const TESTED: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const COMMIT: &str = "beef0000beef0000beef0000beef0000beef0000";

fn report_content<'a>(body: &'a str, kind: &str) -> &'a str {
    let (marker, content) = body.split_once('\n').unwrap();
    let digest = qaren::candidate::sha256_hex(content.as_bytes());
    assert_eq!(
        marker,
        format!("<!-- qaren-run: {RUN}{kind} report={digest} -->")
    );
    content
}

// Plays git's worktree add/remove on disk.
struct Git(MockRunner);

impl Runner for Git {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.args.starts_with(&["worktree".into(), "add".into()]) {
            std::fs::create_dir_all(&spec.args[3]).unwrap();
        }
        if spec.args.starts_with(&["worktree".into(), "remove".into()]) {
            let _ = std::fs::remove_dir_all(spec.args.last().unwrap());
        }
        self.0.execute(spec, interruptible)
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
}

fn machine() -> MachineIdentity {
    MachineIdentity {
        hostname: Some("qa-mac".into()),
        home: Some("/Users/qa".into()),
        ..Default::default()
    }
}

fn run_dir(cross_repository: bool) -> (PathBuf, PathBuf) {
    let repo = common::temp_repo();
    let runs = repo.join("runs");
    let dir = runs.join(RUN);
    for sub in ["blocks", "media", "screenshots"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8081),
        RUN,
        qaren::runrecord::Phase::Cleaned,
    );
    record.terminal = Some(final_terminal());
    record.save(&runs).unwrap();
    let pr = PrRunRecord {
        number: 12,
        url: "https://github.com/o/r/pull/12".into(),
        head_ref_oid: TESTED.into(),
        head_ref_name: "feat/tasks".into(),
        is_cross_repository: cross_repository,
        repo_root: repo.clone(),
        app_rel: "test-app".into(),
        platform: "ios".into(),
        app_id: "com.rndevagent.testapp".into(),
        device: "qaren-check".into(),
        plan_sha256: "e".repeat(64),
        video: VideoStatus::Available,
        video_publication: VideoPublication::Eligible,
        video_withholding_reason: None,
        tested_older_commit: false,
        blocks: vec!["tasks".into()],
        identity_values: Vec::new(),
    };
    std::fs::write(dir.join("pr.json"), serde_json::to_vec(&pr).unwrap()).unwrap();
    std::fs::write(
        dir.join("ledger.json"),
        serde_json::json!({
            "verdict": "FAIL", "path": "walk", "blocks": [],
            "steps": [{"block": "plan", "line": 1, "attempt": 1, "kind": "check", "resolvedBy": "exact",
                       "t": 1, "outcome": "fail", "screenshot": "screenshots/01.png"}],
            "jev": {"calls": 0, "medianMs": 0}, "llmTurns": 0, "escapes": 0, "recoveries": 0,
            "failure": {"step": 1, "seen": "no Tasks", "screenshot": "screenshots/01.png"}
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("blocks/tasks.yaml"), "steps: []\n").unwrap();
    std::fs::write(dir.join("media/video.mp4"), "mp4").unwrap();
    std::fs::write(dir.join("media/video-published.mp4"), "mp4").unwrap();
    std::fs::write(dir.join("screenshots/01.png"), "png").unwrap();
    (runs, dir)
}

fn final_terminal() -> TerminalResult {
    TerminalResult {
        verdict: "FAIL".into(),
        cancelled: false,
        final_verification: FinalVerification {
            tested: TESTED.into(),
            matched: true,
            detail: None,
        },
        ownership_proven: true,
    }
}

fn view(labels: &str) -> CmdOutput {
    CmdOutput::success(&format!(
        r#"{{"number":12,"url":"https://github.com/o/r/pull/12","headRefOid":"{TESTED}","headRefName":"feat/tasks","isCrossRepository":false,"labels":[{labels}]}}"#
    ))
}

fn script_comment_and_label(mock: &mut MockRunner) {
    mock.expect_run(
        "gh pr comment 12 -R github.com/o/r",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1\n"),
    );
    mock.expect_run(
        "gh pr view https://github.com/o/r/pull/12",
        view(r#"{"name":"needs-qa"}"#),
    );
    mock.expect_run(
        "gh pr edit 12 -R github.com/o/r --remove-label needs-qa",
        CmdOutput::success(""),
    );
}

fn script_commit(mock: &mut MockRunner) {
    script_commit_extension(mock, "yaml", "steps: []\n");
}

fn script_commit_extension(mock: &mut MockRunner, extension: &str, bytes: &str) {
    mock.expect_run(
        "git remote get-url --push --all origin",
        CmdOutput::success("git@github.com:o/r.git\n"),
    );
    mock.expect_run(
        &format!("git fetch origin {TESTED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("git worktree add --detach", CmdOutput::success(""));
    mock.expect_run(
        &format!("git add -f -- test-app/.qaren/actions/tasks.{extension}"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        "git commit -m qaren: save block tasks",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "git rev-parse HEAD",
        CmdOutput::success(&format!("{COMMIT}\n")),
    );
    script_blob_check(mock, &format!("tasks.{extension}"), bytes);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("git worktree remove --force", CmdOutput::success(""));
    mock.expect_run(
        "git remote get-url origin",
        CmdOutput::success("git@github.com:o/r.git\n"),
    );
    mock.expect_run(
        "git ls-remote origin refs/heads/feat/tasks",
        CmdOutput::success(&format!("{TESTED}\trefs/heads/feat/tasks\n")),
    );
}

fn script_blob_check(mock: &mut MockRunner, filename: &str, bytes: &str) {
    mock.expect_run(
        "git rev-list --parents",
        CmdOutput::success(&format!("{COMMIT} {TESTED}\n")),
    );
    mock.expect_run(
        "git diff --name-only",
        CmdOutput::success(&format!("test-app/.qaren/actions/{filename}\0")),
    );
    mock.expect_run(
        "git ls-tree",
        CmdOutput::success(&format!(
            "100644 blob {}\ttest-app/.qaren/actions/{filename}\0",
            "a".repeat(40)
        )),
    );
    mock.expect_run("git show", CmdOutput::success(bytes));
}

fn publication(dir: &Path) -> Publication {
    serde_json::from_slice(&std::fs::read(dir.join("publication.json")).unwrap()).unwrap()
}

#[test]
fn cancelled_runs_refuse_new_and_resumed_publication_without_side_effects() {
    for resumed in [false, true] {
        let (runs, dir) = run_dir(false);
        let mut record = qaren::runrecord::RunRecord::load(&runs, RUN).unwrap();
        record.terminal = Some(TerminalResult {
            cancelled: true,
            ..final_terminal()
        });
        record.save(&runs).unwrap();
        let actions = record
            .candidate
            .project_root
            .join(".qaren/actions/tasks.yaml");
        std::fs::create_dir_all(actions.parent().unwrap()).unwrap();
        std::fs::write(&actions, "steps: []\n").unwrap();
        let prior = serde_json::to_vec(&Publication {
            rendered: true,
            comment_attempted: true,
            comment_url: Some("https://github.com/o/r/pull/12#issuecomment-1".into()),
            ..Default::default()
        })
        .unwrap();
        if resumed {
            std::fs::write(dir.join("publication.json"), &prior).unwrap();
        }
        let mut runner = Git(MockRunner::new());
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(receipt.result, ReceiptResult::Refused);
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.code, qaren::failure::FailureCode::RunCancelled);
        assert!(failure.code.is_refusal());
        assert!(runner.0.calls.is_empty());
        assert!(receipt.outcomes.is_empty());
        assert!(!dir.join("comment.md").exists());
        assert!(!dir.join("blocks-comment.md").exists());
        assert_eq!(std::fs::read_to_string(&actions).unwrap(), "steps: []\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("blocks/tasks.yaml")).unwrap(),
            "steps: []\n"
        );
        if resumed {
            assert_eq!(std::fs::read(dir.join("publication.json")).unwrap(), prior);
        } else {
            assert!(!dir.join("publication.json").exists());
        }
    }
}

#[test]
fn publish_comments_removes_the_label_and_pushes_the_blocks_with_the_exact_lease() {
    let (runs, dir) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner
        .0
        .expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.0.remaining(), 0);
    let comment = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "gh-pr-comment")
        .unwrap();
    assert_eq!(comment.cwd.as_deref(), Some(dir.as_path()));
    assert!(comment
        .args
        .contains(&"./media/video-published.mp4".to_string()));
    assert!(!comment.args.contains(&"./media/video.mp4".to_string()));
    assert!(comment
        .args
        .contains(&"./screenshots/01.png#Failing step".to_string()));
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(report_content(&body, "").starts_with("FAIL"));
    let commit = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "git-commit-blocks")
        .unwrap();
    assert_eq!(
        commit.args,
        [
            "commit",
            "-m",
            "qaren: save block tasks",
            "-m",
            &format!("Qaren-Run: {RUN}")
        ]
    );
    assert!(!commit.args.iter().any(|a| a.contains("user.")));
    let push = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "git-push-blocks")
        .unwrap();
    assert_eq!(
        push.args,
        [
            "push",
            "origin",
            &format!("{COMMIT}:refs/heads/feat/tasks"),
            &format!("--force-with-lease=feat/tasks:{TESTED}"),
        ]
    );
    let done = publication(&dir);
    assert_eq!(
        done.comment_url.as_deref(),
        Some("https://github.com/o/r/pull/12#issuecomment-1")
    );
    assert_eq!(done.label.as_deref(), Some("removed"));
    assert_eq!(
        done.writeback.as_deref(),
        Some(format!("committed {COMMIT}").as_str())
    );
    assert!(!dir.join("writeback-wt").exists());

    // A rerun of a finished publication runs nothing and changes nothing.
    let before = std::fs::read(dir.join("publication.json")).unwrap();
    let mut again = Git(MockRunner::new());
    let receipt = publish(&mut again, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    assert!(again.0.calls.is_empty());
    assert_eq!(std::fs::read(dir.join("publication.json")).unwrap(), before);
}

#[test]
fn a_rerun_after_the_comment_posts_no_second_comment() {
    let (runs, dir) = run_dir(false);
    let mut first = Git(MockRunner::new());
    first.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1\n"),
    );
    first
        .0
        .expect_run("gh pr view", CmdOutput::failed(1, "network down"));
    let receipt = publish(&mut first, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);

    let mut second = Git(MockRunner::new());
    second.0.expect_run("gh pr view", view(""));
    script_commit(&mut second.0);
    second
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut second, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!second.0.calls.iter().any(|c| c.label == "gh-pr-comment"));
    assert_eq!(publication(&dir).label.as_deref(), Some("absent"));
    assert_eq!(second.0.remaining(), 0);
}

#[test]
fn a_lost_attached_comment_is_adopted_after_github_rewrites_its_body() {
    let (runs, dir) = run_dir(false);
    let mut first = Git(MockRunner::new());
    first.0.expect_run(
        "gh pr comment",
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
    );
    assert_eq!(
        publish(&mut first, &runs, RUN, &machine()).result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).comment_attempted);
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    report_content(&body, "");
    let posted = format!(
        "{}\n<video src=\"https://github.com/user-attachments/video\"></video>",
        body.replace(
            "./screenshots/01.png",
            "https://github.com/user-attachments/image"
        )
    );
    assert_ne!(body, posted);
    std::fs::remove_file(dir.join("comment.md")).unwrap();

    let mut second = Git(MockRunner::new());
    second
        .0
        .expect_run("gh api user", CmdOutput::success("publisher\n"));
    second.0.expect_run(
        "gh pr view 12 -R github.com/o/r --json comments",
        CmdOutput::success(&serde_json::json!({"comments": [
            {"body": "unrelated", "url": "https://github.com/o/r/pull/12#issuecomment-0"},
            {"body": posted, "author": {"login": "publisher"}, "url": "https://github.com/o/r/pull/12#issuecomment-7"}
        ]}).to_string()),
    );
    second
        .0
        .expect_run("gh pr view https://github.com/o/r/pull/12", view(""));
    script_commit(&mut second.0);
    second
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut second, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!second.0.calls.iter().any(|c| c.label == "gh-pr-comment"));
    assert_eq!(
        publication(&dir).comment_url.as_deref(),
        Some("https://github.com/o/r/pull/12#issuecomment-7")
    );
}

#[test]
fn a_rejected_lease_attaches_the_yaml_in_a_second_comment() {
    let (runs, dir) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner.0.expect_run(
        "git push origin",
        CmdOutput::failed(1, "! [rejected] (stale info)"),
    );
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.0.remaining(), 0);
    let blocks = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
    assert!(blocks.contains("<details><summary>Saved blocks to commit</summary>"));
    assert!(blocks.contains("` test-app/.qaren/actions/tasks.yaml `"));
    assert!(blocks.contains("```yaml\nsteps: []\n```"));
    let done = publication(&dir);
    assert_eq!(
        done.writeback.as_deref(),
        Some("attached https://github.com/o/r/pull/12#issuecomment-2")
    );
    assert!(std::fs::read_to_string(dir.join("comment.md"))
        .unwrap()
        .contains("FAIL"));
}

#[test]
fn a_fork_pr_gets_the_yaml_comment_and_no_push() {
    let (runs, dir) = run_dir(true);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-3\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!runner.0.calls.iter().any(|c| c.program == "git"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
}

#[test]
fn an_origin_that_is_not_the_pr_repository_gets_the_yaml_comment_and_no_push() {
    let (runs, dir) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    runner.0.expect_run(
        "git remote get-url --push --all origin",
        CmdOutput::success("git@github.com:someone/else.git\n"),
    );
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-4\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!runner.0.calls.iter().any(|c| c.label == "git-push-blocks"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
}

// The PR controls the checked-out tree; a symlinked corpus must not redirect the write.
struct SymlinkedCorpus(Git);

impl Runner for SymlinkedCorpus {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        let output = self.0.execute(spec, interruptible);
        if spec.args.starts_with(&["worktree".into(), "add".into()]) {
            let wt = PathBuf::from(&spec.args[3]);
            let outside = wt.parent().unwrap().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::create_dir_all(wt.join("test-app")).unwrap();
            std::os::unix::fs::symlink(&outside, wt.join("test-app/.qaren")).unwrap();
        }
        output
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
}

#[test]
fn a_symlinked_corpus_in_the_pr_tree_is_refused_and_the_yaml_is_attached() {
    let (runs, dir) = run_dir(false);
    let mut runner = SymlinkedCorpus(Git(MockRunner::new()));
    let mock = &mut runner.0 .0;
    script_comment_and_label(mock);
    mock.expect_run(
        "git remote get-url --push --all origin",
        CmdOutput::success("https://github.com/o/r\n"),
    );
    mock.expect_run(
        &format!("git fetch origin {TESTED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("git worktree add --detach", CmdOutput::success(""));
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("git worktree remove --force", CmdOutput::success(""));
    mock.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-5\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!dir.join("outside/actions").exists());
    assert!(!runner
        .0
         .0
        .calls
        .iter()
        .any(|c| c.label == "git-commit-blocks"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
    assert_eq!(runner.0 .0.remaining(), 0);
}

#[test]
fn a_live_publisher_holds_the_run() {
    let (runs, dir) = run_dir(false);
    use std::os::fd::AsRawFd;
    let held = std::fs::File::create(dir.join("publish.lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let mut runner = Git(MockRunner::new());
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(receipt
        .failure
        .unwrap()
        .detail
        .contains("another qaren publish"));
    assert!(runner.0.calls.is_empty());
    assert!(dir.join("publish.lock").exists());
}

#[test]
fn an_unreadable_publication_state_fails_closed() {
    let (runs, dir) = run_dir(false);
    std::fs::write(dir.join("publication.json"), "{not json").unwrap();
    let mut runner = Git(MockRunner::new());
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(runner.0.calls.is_empty());
}

// Records what each `git add` stages, as the commit will contain it.
struct Staged(Git, Vec<String>);

impl Runner for Staged {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "git-add-blocks" {
            let cwd = spec.cwd.clone().unwrap();
            for path in &spec.args[3..] {
                self.1
                    .push(std::fs::read_to_string(cwd.join(path)).unwrap());
            }
        }
        self.0.execute(spec, interruptible)
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
}

const SECRET: &str = "Hunter2Fixture!Synth";

fn edit_pr(dir: &Path, change: impl FnOnce(&mut serde_json::Value)) {
    let path = dir.join("pr.json");
    let mut pr: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    change(&mut pr);
    std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
}

fn calls_named(runner: &MockRunner, label: &str) -> usize {
    runner.calls.iter().filter(|c| c.label == label).count()
}

#[test]
fn the_raw_plan_is_never_published() {
    let (runs, dir) = run_dir(false);
    std::fs::write(
        dir.join("plan.md"),
        format!("fill password with \"{SECRET}\"\n"),
    )
    .unwrap();
    edit_pr(&dir, |pr| pr["blocks"] = serde_json::json!([]));
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(!body.contains(SECRET), "{body}");
    assert!(body.contains("- ✗ line 1\n"), "{body}");
}

#[test]
fn blocks_from_a_walk_that_is_not_eligible_are_withheld() {
    for eligibility in [
        Some(serde_json::json!("withheld-fill")),
        Some(serde_json::json!("withheld-privacy")),
        Some(serde_json::json!("unknown")),
        None,
    ] {
        let (runs, dir) = run_dir(false);
        std::fs::write(
            dir.join("blocks/tasks.yaml"),
            format!("steps:\n  - inputText: \"{SECRET}\"\n"),
        )
        .unwrap();
        edit_pr(&dir, |pr| match &eligibility {
            Some(value) => pr["videoPublication"] = value.clone(),
            None => {
                pr.as_object_mut().unwrap().remove("videoPublication");
            }
        });
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);

        let receipt = publish(&mut runner, &runs, RUN, &machine());

        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{eligibility:?}: {:?}",
            receipt.failure
        );
        assert_eq!(runner.0.remaining(), 0, "{eligibility:?}");
        assert_eq!(calls_named(&runner.0, "git-commit-blocks"), 0);
        assert_eq!(calls_named(&runner.0, "git-push-blocks"), 0);
        assert_eq!(
            calls_named(&runner.0, "gh-pr-comment"),
            1,
            "only the QA comment"
        );
        assert!(!dir.join("blocks-comment.md").exists());
        assert_eq!(
            receipt.outcomes["writeback"],
            "withheld tasks: the walk was not eligible for publication"
        );
        assert!(
            dir.join("blocks/tasks.yaml").is_file(),
            "kept for the operator"
        );
    }
}

#[test]
fn an_eligible_parameterised_block_is_committed_byte_identical() {
    let (runs, dir) = run_dir(false);
    let source = "steps:\n  - inputText: ${PASSWORD}\n    into: \"Password\"\n";
    std::fs::write(dir.join("blocks/tasks.yaml"), source).unwrap();
    let mut runner = Staged(Git(MockRunner::new()), Vec::new());
    script_comment_and_label(&mut runner.0 .0);
    script_commit_extension(&mut runner.0 .0, "yaml", source);
    runner
        .0
         .0
        .expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.1, [source]);
    assert_eq!(receipt.outcomes["writeback"], format!("committed {COMMIT}"));
}

#[test]
fn a_block_the_redaction_would_change_is_withheld_never_rewritten() {
    for content in [
        "steps:\n  - open: /Users/qa-fixture-user/x\n".to_string(),
        "steps:\n  - device: emulator-5554\n".to_string(),
        "steps:\n  - key: |\n      -----BEGIN PRIVATE KEY-----\n      FAKEFIXTUREBODY\n      -----END PRIVATE KEY-----\n".to_string(),
    ] {
        let (runs, dir) = run_dir(false);
        std::fs::write(dir.join("blocks/tasks.yaml"), &content).unwrap();
        edit_pr(&dir, |pr| pr["identityValues"] = serde_json::json!(["emulator-5554"]));
        let mut runner = Staged(Git(MockRunner::new()), Vec::new());
        script_comment_and_label(&mut runner.0 .0);

        let receipt = publish(&mut runner, &runs, RUN, &fixture_machine());

        assert_eq!(receipt.result, ReceiptResult::Published, "{:?}", receipt.failure);
        assert!(runner.1.is_empty(), "nothing staged for {content}");
        assert_eq!(calls_named(&runner.0 .0, "git-commit-blocks"), 0);
        assert!(!dir.join("blocks-comment.md").exists());
        assert_eq!(
            receipt.outcomes["writeback"],
            "withheld tasks: the block carries a secret or machine identity"
        );
        assert_eq!(std::fs::read_to_string(dir.join("blocks/tasks.yaml")).unwrap(), content);
    }
}

fn fixture_machine() -> MachineIdentity {
    MachineIdentity {
        hostname: Some("qa-fixture-host".into()),
        home: Some("/Users/qa-fixture-user".into()),
        username: Some("qa-fixture-user".into()),
        values: Vec::new(),
    }
}

#[test]
fn the_runs_identity_values_and_tool_vocabulary_never_reach_the_comment() {
    let (runs, dir) = run_dir(false);
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!([]);
        pr["identityValues"] = serde_json::json!(["emulator-5554", "R58M00SYNTH0", "8081", "8791"]);
    });
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("ledger.json")).unwrap()).unwrap();
    ledger["failure"]["seen"] = serde_json::json!(
        "qa-fixture-user saw emulator-5554 and R58M00SYNTH0 via 127.0.0.1:8081 on port 8791 using xcrun simctl and adb -s; build 180812 kept"
    );
    std::fs::write(dir.join("ledger.json"), ledger.to_string()).unwrap();
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);

    let receipt = publish(&mut runner, &runs, RUN, &fixture_machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    let tokens: Vec<&str> = body
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .collect();
    for leak in [
        "qa-fixture-user",
        "emulator-5554",
        "R58M00SYNTH0",
        "8081",
        "8791",
    ] {
        assert!(!tokens.contains(&leak), "{leak} leaked:\n{body}");
    }
    for phrase in ["xcrun simctl", "adb -s"] {
        assert!(!body.contains(phrase), "{phrase} leaked:\n{body}");
    }
    assert!(
        body.contains("180812"),
        "a longer token is left alone:\n{body}"
    );
}

#[test]
fn withheld_or_unknown_eligibility_never_uploads_video() {
    for eligibility in [
        None,
        Some(serde_json::json!("withheld-fill")),
        Some(serde_json::json!("withheld-privacy")),
        Some(serde_json::json!("future-status")),
        Some(serde_json::json!({"invalid": true})),
        Some(serde_json::Value::Null),
    ] {
        let (runs, dir) = run_dir(false);
        let path = dir.join("pr.json");
        let mut pr: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pr["blocks"] = serde_json::json!([]);
        let fill = eligibility == Some(serde_json::json!("withheld-fill"));
        if let Some(value) = eligibility {
            pr["videoPublication"] = value;
        } else {
            pr.as_object_mut().unwrap().remove("videoPublication");
        }
        std::fs::write(&path, serde_json::to_vec(&pr).unwrap()).unwrap();
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{:?}",
            receipt.failure
        );
        let comment = runner
            .0
            .calls
            .iter()
            .find(|c| c.label == "gh-pr-comment")
            .unwrap();
        assert!(!comment.args.iter().any(|arg| arg.contains("video.mp4")));
        let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
        assert!(body.contains("Video withheld:"));
        if fill {
            assert!(
                body.contains(
                    "Video withheld: the plan has a fill or type step, or a login replay typed into a field.\n"
                ),
                "{body}"
            );
        }
        assert!(!body.contains("Video of the walk is attached"));
        assert!(dir.join("media/video.mp4").is_file());
        assert_eq!(runner.0.remaining(), 0);
    }
}

#[test]
fn withheld_fill_reason_holds_when_the_plan_fill_never_ran() {
    let (runs, dir) = run_dir(false);
    let path = dir.join("pr.json");
    let mut pr: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    pr["blocks"] = serde_json::json!([]);
    pr["videoPublication"] = serde_json::json!("withheld-fill");
    std::fs::write(&path, serde_json::to_vec(&pr).unwrap()).unwrap();
    let ledger: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("ledger.json")).unwrap()).unwrap();
    assert!(ledger["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|step| step["kind"] != "fill"));
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(
        body.contains(
            "Video withheld: the plan has a fill or type step, or a login replay typed into a field.\n"
        ),
        "{body}"
    );
    assert!(!body.contains("the walk typed"), "{body}");
}

#[test]
fn publishing_an_older_head_retains_the_qa_request_and_receipt() {
    let (runs, dir) = run_dir(false);
    let path = dir.join("pr.json");
    let mut pr: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    pr["blocks"] = serde_json::json!([]);
    std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
    let mut runner = Git(MockRunner::new());
    runner.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1"),
    );
    let mut current: serde_json::Value =
        serde_json::from_str(&view(r#"{"name":"needs-qa"}"#).stdout).unwrap();
    current["headRefOid"] = serde_json::json!(COMMIT);
    runner
        .0
        .expect_run("gh pr view", CmdOutput::success(&current.to_string()));
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    assert_eq!(receipt.outcomes["label"], "retained-head-changed");
    assert_eq!(
        publication(&dir).label.as_deref(),
        Some("retained-head-changed")
    );
    assert!(!runner
        .0
        .calls
        .iter()
        .any(|c| c.args.contains(&"--remove-label".into())));
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn an_abandoned_empty_or_partial_lock_does_not_block_publication() {
    for content in ["", "not-a-pid", "12"] {
        let (runs, dir) = run_dir(false);
        std::fs::write(dir.join("publish.lock"), content).unwrap();
        let path = dir.join("pr.json");
        let mut pr: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pr["blocks"] = serde_json::json!([]);
        std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);
        assert_eq!(
            publish(&mut runner, &runs, RUN, &machine()).result,
            ReceiptResult::Published
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("publish.lock")).unwrap(),
            content
        );
    }
}

struct Uploads {
    runner: Git,
    bodies: Vec<(String, String)>,
}

impl Runner for Uploads {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "gh-pr-comment" {
            let at = spec
                .args
                .iter()
                .position(|arg| arg == "--body-file")
                .unwrap();
            let file = &spec.args[at + 1];
            let body = std::fs::read_to_string(spec.cwd.as_ref().unwrap().join(file)).unwrap();
            self.bodies.push((file.clone(), body));
        }
        self.runner.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.runner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.runner.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.runner.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.runner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.runner.commands_executed()
    }
}

#[test]
fn retry_regenerates_an_unposted_walk_comment_with_current_privacy() {
    let (runs, dir) = run_dir(false);
    edit_pr(&dir, |pr| pr["blocks"] = serde_json::json!([]));
    let ledger_path = dir.join("ledger.json");
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&ledger_path).unwrap()).unwrap();
    ledger["failure"]["seen"] = serde_json::json!("qa-fixture-user saw the missing Tasks tab.");
    std::fs::write(ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    let mut first = Git(MockRunner::new());
    first
        .0
        .expect_run("gh pr comment", CmdOutput::failed(1, "offline"));
    assert_eq!(
        publish(&mut first, &runs, RUN, &MachineIdentity::default()).result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).rendered);
    assert!(std::fs::read_to_string(dir.join("comment.md"))
        .unwrap()
        .contains("qa-fixture-user"));
    std::fs::write(dir.join("plan.md"), "Fill password with raw-plan-secret").unwrap();
    let mut second = Uploads {
        runner: Git(MockRunner::new()),
        bodies: Vec::new(),
    };
    second
        .runner
        .0
        .expect_run("gh api user", CmdOutput::success("publisher\n"));
    second
        .runner
        .0
        .expect_run("gh pr view 12", CmdOutput::success(r#"{"comments":[]}"#));
    script_comment_and_label(&mut second.runner.0);
    let receipt = publish(&mut second, &runs, RUN, &fixture_machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(second.runner.0.remaining(), 0);
    assert_eq!(second.bodies.len(), 1);
    let (file, body) = &second.bodies[0];
    assert_eq!(file, "comment.md");
    report_content(body, "");
    assert!(body.contains(r"\<user\> saw the missing Tasks tab."));
    assert!(!body.contains("qa-fixture-user"));
    assert!(!body.contains("raw-plan-secret"));
}

#[test]
fn retry_regenerates_unposted_blocks_through_the_current_block_gate() {
    let (runs, dir) = run_dir(true);
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!(["tasks", "safe"])
    });
    std::fs::write(
        dir.join("blocks/tasks.yaml"),
        "name: qa-fixture-user\nsteps: []\n",
    )
    .unwrap();
    std::fs::write(dir.join("blocks/safe.yaml"), "name: Safe\nsteps: []\n").unwrap();
    let mut first = Git(MockRunner::new());
    script_comment_and_label(&mut first.0);
    first
        .0
        .expect_run("gh pr comment", CmdOutput::failed(1, "offline"));
    assert_eq!(
        publish(&mut first, &runs, RUN, &MachineIdentity::default()).result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).blocks_comment_attempted);
    assert!(std::fs::read_to_string(dir.join("blocks-comment.md"))
        .unwrap()
        .contains("qa-fixture-user"));
    let posted_walk = std::fs::read(dir.join("comment.md")).unwrap();
    let mut second = Uploads {
        runner: Git(MockRunner::new()),
        bodies: Vec::new(),
    };
    second
        .runner
        .0
        .expect_run("gh api user", CmdOutput::success("publisher\n"));
    second
        .runner
        .0
        .expect_run("gh pr view 12", CmdOutput::success(r#"{"comments":[]}"#));
    second.runner.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2"),
    );
    let receipt = publish(&mut second, &runs, RUN, &fixture_machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(second.runner.0.remaining(), 0);
    assert_eq!(second.bodies.len(), 1);
    let (file, body) = &second.bodies[0];
    assert_eq!(file, "blocks-comment.md");
    report_content(body, " blocks");
    assert!(body.contains("name: Safe\nsteps: []"));
    assert!(!body.contains("tasks.yaml"));
    assert!(!body.contains("qa-fixture-user"));
    assert_eq!(std::fs::read(dir.join("comment.md")).unwrap(), posted_walk);
    assert!(receipt.outcomes["writeback"].contains("withheld tasks"));

    let mut again = Git(MockRunner::new());
    assert_eq!(
        publish(&mut again, &runs, RUN, &fixture_machine()).result,
        ReceiptResult::Published
    );
    assert!(again.0.calls.is_empty());
}

// The exact shape Phase 4's serializer writes for an eligible walk (qaren-core blocks.test.ts golden).
fn producer_block(plan_hash: &str) -> String {
    [
        "appId: com.example.app",
        "---",
        "# id: onboarding-to-the-tasks-tab",
        "# intent: Onboarding to the tasks tab",
        "# status: active",
        "# appId: com.example.app",
        "# plan: onboarding-to-the-tasks-tab",
        &format!("# planHash: {plan_hash}"),
        "# platform: ios",
        "",
        "# 1. Tap \"onboarding-skip\"",
        "- tapOn: { id: \"onboarding-skip\" }",
        "# 2. Tap \"onboarding-done\"",
        "- tapOn: { id: \"onboarding-done\" }",
        "# 3. Wait for \"Welcome\" to appear",
        "- extendedWaitUntil: { visible: { text: \"Welcome\" }, timeout: 15000 }",
        "# ✓ \"Welcome\"",
        "- assertVisible: { text: \"Welcome\" }",
        "# 4. Tap \"tab-tasks\"",
        "- tapOn: { id: \"tab-tasks\" }",
        "",
    ]
    .join("\n")
}

#[test]
fn a_block_in_the_producers_format_from_an_eligible_walk_is_committed_byte_identical() {
    let (runs, dir) = run_dir(false);
    let slug = "onboarding-to-the-tasks-tab";
    let source = producer_block(&"3f".repeat(32));
    std::fs::write(dir.join(format!("blocks/{slug}.yaml")), &source).unwrap();
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!([slug]);
        pr["identityValues"] = serde_json::json!([
            "qaren-check",
            "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
            "8081"
        ]);
    });
    let mut runner = Staged(Git(MockRunner::new()), Vec::new());
    script_comment_and_label(&mut runner.0 .0);
    let mock = &mut runner.0 .0;
    mock.expect_run(
        "git remote get-url --push --all origin",
        CmdOutput::success("git@github.com:o/r.git\n"),
    );
    mock.expect_run(
        &format!("git fetch origin {TESTED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("git worktree add --detach", CmdOutput::success(""));
    mock.expect_run(
        &format!("git add -f -- test-app/.qaren/actions/{slug}.yaml"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        &format!("git commit -m qaren: save block {slug}"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        "git rev-parse HEAD",
        CmdOutput::success(&format!("{COMMIT}\n")),
    );
    script_blob_check(mock, &format!("{slug}.yaml"), &source);
    mock.expect_run("du -sk", CmdOutput::success("4\n"));
    mock.expect_run("git worktree remove --force", CmdOutput::success(""));
    mock.expect_run(
        "git remote get-url origin",
        CmdOutput::success("git@github.com:o/r.git\n"),
    );
    mock.expect_run(
        "git ls-remote origin refs/heads/feat/tasks",
        CmdOutput::success(&format!("{TESTED}\trefs/heads/feat/tasks\n")),
    );
    mock.expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &fixture_machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.1, [source]);
    assert_eq!(receipt.outcomes["writeback"], format!("committed {COMMIT}"));
}

#[test]
fn patched_blocks_keep_their_extension_through_preservation_and_publication() {
    struct ExistingBlock {
        git: Git,
        extension: &'static str,
        bytes: Vec<u8>,
        written: bool,
    }
    impl Runner for ExistingBlock {
        fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
            if spec.label == "git-worktree-add" {
                let actions = Path::new(&spec.args[3]).join("test-app/.qaren/actions");
                std::fs::create_dir_all(&actions).unwrap();
                std::fs::write(
                    actions.join(format!("tasks.{}", self.extension)),
                    "old block",
                )
                .unwrap();
            }
            if spec.label == "git-add-blocks" {
                let actions = spec.cwd.as_ref().unwrap().join("test-app/.qaren/actions");
                assert_eq!(
                    std::fs::read(actions.join(format!("tasks.{}", self.extension))).unwrap(),
                    self.bytes
                );
                let other = if self.extension == "yml" {
                    "yaml"
                } else {
                    "yml"
                };
                assert!(!actions.join(format!("tasks.{other}")).exists());
                self.written = true;
            }
            self.git.execute(spec, interruptible)
        }
        fn spawn_group_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<Spawned> {
            self.git.spawn_group_unchecked(spec, log)
        }
        fn spawn_piped_unchecked(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<PipedChild> {
            self.git.spawn_piped_unchecked(spec, log)
        }
        fn sleep(&mut self, d: std::time::Duration) {
            self.git.sleep(d)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.git.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.git.commands_executed()
        }
    }
    for extension in ["yml", "yaml"] {
        for fallback in [false, true] {
            let (runs, dir) = run_dir(fallback);
            let app = runs.parent().unwrap().join("patched-app");
            let actions = app.join(".qaren/actions");
            std::fs::create_dir_all(&actions).unwrap();
            let bytes = b"# patched block\r\nsteps: []\r\n\n";
            std::fs::write(actions.join(format!("tasks.{extension}")), bytes).unwrap();
            std::fs::remove_file(dir.join("blocks/tasks.yaml")).unwrap();
            let (copied, refused) = qaren::worktree::copy_blocks(
                &mut qaren::exec::RealRunner::new(),
                &app,
                &["tasks".into()],
                &dir.join("blocks"),
            );
            assert_eq!(copied, ["tasks"]);
            assert!(refused.is_empty());
            assert_eq!(
                std::fs::read(dir.join(format!("blocks/tasks.{extension}"))).unwrap(),
                bytes
            );
            let mut runner = ExistingBlock {
                git: Git(MockRunner::new()),
                extension,
                bytes: bytes.to_vec(),
                written: false,
            };
            script_comment_and_label(&mut runner.git.0);
            if fallback {
                runner.git.0.expect_run(
                    "gh pr comment 12",
                    CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2\n"),
                );
            } else {
                script_commit_extension(
                    &mut runner.git.0,
                    extension,
                    std::str::from_utf8(bytes).unwrap(),
                );
                runner
                    .git
                    .0
                    .expect_run("git push origin", CmdOutput::success(""));
            }
            let receipt = publish(&mut runner, &runs, RUN, &machine());
            assert_eq!(
                receipt.result,
                ReceiptResult::Published,
                "{:?}",
                receipt.failure
            );
            assert_eq!(runner.git.0.remaining(), 0);
            if fallback {
                let comment = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
                assert!(comment.contains(&format!("` test-app/.qaren/actions/tasks.{extension} `")));
                assert!(comment.contains("# patched block\r\nsteps: []"));
                assert!(!runner.written);
            } else {
                assert!(runner.written);
                assert_eq!(
                    publication(&dir).writeback.as_deref(),
                    Some(format!("committed {COMMIT}").as_str())
                );
            }
        }
    }
}

struct LocalPublication {
    calls: Vec<CmdSpec>,
    reject_push: bool,
    reject_comment: bool,
    real_urls: bool,
}

fn local_git(repo: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

impl Runner for LocalPublication {
    fn execute(&mut self, spec: &CmdSpec, _interruptible: bool) -> CmdOutput {
        self.calls.push(spec.clone());
        match spec.label.as_str() {
            "git-push-url" | "git-fetch-url" if !self.real_urls => {
                CmdOutput::success("git@github.com:o/r.git\n")
            }
            "git-push-blocks" if self.reject_push => CmdOutput::failed(1, "push unavailable"),
            "gh-user" => CmdOutput::success("publisher\n"),
            "gh-pr-comments" => CmdOutput::success("{\"comments\":[]}"),
            "gh-pr-comment" if self.reject_comment => CmdOutput::failed(1, "post unavailable"),
            "gh-pr-comment" => {
                CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2\n")
            }
            _ => {
                assert!(matches!(spec.program.as_str(), "git" | "du"));
                let mut command = std::process::Command::new(&spec.program);
                if let Some(cwd) = &spec.cwd {
                    command.current_dir(cwd);
                }
                let output = command
                    .args(&spec.args)
                    .envs(spec.env.iter().cloned())
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .output()
                    .unwrap();
                CmdOutput {
                    exit_code: output.status.code(),
                    stdout: String::from_utf8(output.stdout).unwrap(),
                    stderr: String::from_utf8(output.stderr).unwrap(),
                    ..Default::default()
                }
            }
        }
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        unreachable!()
    }
    fn spawn_piped_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<PipedChild> {
        unreachable!()
    }
    fn sleep(&mut self, _: std::time::Duration) {}
    fn now_epoch_ms(&self) -> u64 {
        0
    }
    fn commands_executed(&self) -> u64 {
        self.calls.len() as u64
    }
}

#[test]
fn cached_writeback_retries_apply_current_admission_without_rewriting_history() {
    for mode in [
        "stale",
        "safe",
        "landed",
        "withheld",
        "privacy-failure",
        "fallback",
        "ancestor",
    ] {
        let (runs, dir) = run_dir(false);
        let repo = runs.parent().unwrap();
        let remote = repo.join("remote.git");
        std::fs::create_dir(&remote).unwrap();
        local_git(&remote, &["init", "--bare"]);
        local_git(repo, &["init"]);
        local_git(repo, &["config", "user.name", "QA"]);
        local_git(repo, &["config", "user.email", "qa@example.com"]);
        std::fs::write(repo.join("product"), "approved product\n").unwrap();
        local_git(repo, &["add", "product"]);
        local_git(repo, &["commit", "-m", "product"]);
        std::fs::write(repo.join("pipeline"), "approved pipeline fix\n").unwrap();
        local_git(repo, &["add", "pipeline"]);
        local_git(repo, &["commit", "-m", "pipeline fix"]);
        let base = local_git(repo, &["rev-parse", "HEAD"]).trim().to_string();
        local_git(repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        local_git(repo, &["push", "origin", "HEAD:refs/heads/feat/tasks"]);
        let bytes = "# safe block\r\nsteps: []\r\n\n";
        std::fs::rename(dir.join("blocks/tasks.yaml"), dir.join("blocks/tasks.yml")).unwrap();
        std::fs::write(dir.join("blocks/tasks.yml"), bytes).unwrap();
        std::fs::write(dir.join("blocks/private.yaml"), "# Alice\nsteps: []\n").unwrap();
        edit_pr(&dir, |pr| {
            pr["headRefOid"] = base.clone().into();
            pr["blocks"] = if mode == "safe" {
                serde_json::json!(["tasks"])
            } else {
                serde_json::json!(["tasks", "private"])
            };
        });
        std::fs::write(
            dir.join("publication.json"),
            serde_json::to_vec(&Publication {
                comment_url: Some("https://github.com/o/r/pull/12#issuecomment-1".into()),
                label: Some("removed".into()),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        let mut runner = LocalPublication {
            calls: Vec::new(),
            reject_push: true,
            reject_comment: true,
            real_urls: false,
        };
        assert_eq!(
            publish(&mut runner, &runs, RUN, &machine()).result,
            ReceiptResult::Failed
        );
        let mut old = publication(&dir).writeback_commit.unwrap();
        assert!(publication(&dir).blocks_comment_attempted);
        if mode == "ancestor" {
            let tree = local_git(repo, &["rev-parse", &format!("{old}^{{tree}}")]);
            old = local_git(
                repo,
                &[
                    "commit-tree",
                    tree.trim(),
                    "-p",
                    &old,
                    "-m",
                    "cached descendant",
                ],
            )
            .trim()
            .into();
            let mut state = publication(&dir);
            state.writeback_commit = Some(old.clone());
            std::fs::write(
                dir.join("publication.json"),
                serde_json::to_vec(&state).unwrap(),
            )
            .unwrap();
        }
        if mode == "landed" {
            local_git(
                repo,
                &["push", "origin", &format!("{old}:refs/heads/feat/tasks")],
            );
        }
        let mut current_machine = machine();
        current_machine.username = Some("Alice".into());
        if mode == "withheld" {
            edit_pr(&dir, |pr| pr["videoPublication"] = "withheld".into());
        }
        if mode == "privacy-failure" {
            std::fs::remove_file(dir.join("blocks/private.yaml")).unwrap();
        }
        runner.calls.clear();
        runner.reject_push = mode == "fallback";
        runner.reject_comment = false;
        let receipt = publish(&mut runner, &runs, RUN, &current_machine);
        assert_eq!(
            receipt.result,
            if mode == "privacy-failure" {
                ReceiptResult::Failed
            } else {
                ReceiptResult::Published
            },
            "{mode}: {:?}",
            receipt.failure
        );
        let pushes: Vec<_> = runner
            .calls
            .iter()
            .filter(|c| c.label == "git-push-blocks")
            .collect();
        if matches!(mode, "landed" | "withheld" | "privacy-failure") {
            assert!(pushes.is_empty(), "{mode}");
            assert!(!runner.calls.iter().any(|c| c.label == "gh-pr-comment"));
        } else {
            assert_eq!(pushes.len(), 1, "{mode}");
            let new = pushes[0].args[2].split(':').next().unwrap();
            assert_eq!(new == old, mode == "safe", "{mode}");
            assert_eq!(
                local_git(repo, &["rev-list", "--parents", "-n", "1", new]).trim(),
                format!("{new} {base}")
            );
            assert_eq!(
                local_git(
                    repo,
                    &["show", &format!("{new}:test-app/.qaren/actions/tasks.yml")]
                ),
                bytes
            );
            assert_eq!(
                local_git(
                    repo,
                    &[
                        "ls-tree",
                        "--name-only",
                        "-r",
                        new,
                        "--",
                        "test-app/.qaren/actions"
                    ]
                ),
                "test-app/.qaren/actions/tasks.yml\n"
            );
            assert_eq!(
                local_git(repo, &["show", &format!("{new}:product")]),
                "approved product\n"
            );
            assert_eq!(
                local_git(repo, &["show", &format!("{new}:pipeline")]),
                "approved pipeline fix\n"
            );
            if mode == "fallback" {
                let body = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
                assert!(body.contains(bytes));
                assert!(body.contains("tasks.yml"));
                assert!(!body.contains("Alice"));
                assert!(!body.contains("private.yaml"));
            } else {
                assert_eq!(
                    local_git(&remote, &["rev-parse", "refs/heads/feat/tasks"]).trim(),
                    new
                );
            }
        }
        assert_eq!(local_git(repo, &["rev-parse", "HEAD"]).trim(), base);
        assert!(local_git(repo, &["cat-file", "-t", &old]).starts_with("commit"));
        if mode == "landed" {
            assert_eq!(publication(&dir).writeback.unwrap(), format!("committed {old}; withheld private: the block carries a secret or machine identity"));
            assert_eq!(
                local_git(&remote, &["rev-parse", "refs/heads/feat/tasks"]).trim(),
                old
            );
        }
        std::fs::remove_dir_all(repo).unwrap();
    }
}

fn local_publication_fixture() -> (PathBuf, PathBuf, String) {
    let (runs, dir) = run_dir(false);
    let repo = runs.parent().unwrap();
    let remote = repo.join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    local_git(&remote, &["init", "--bare"]);
    local_git(repo, &["init"]);
    local_git(repo, &["config", "user.name", "QA"]);
    local_git(repo, &["config", "user.email", "qa@example.com"]);
    std::fs::write(repo.join("product"), "approved product\n").unwrap();
    local_git(repo, &["add", "product"]);
    local_git(repo, &["commit", "-m", "product"]);
    let base = local_git(repo, &["rev-parse", "HEAD"]).trim().to_string();
    local_git(repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    local_git(repo, &["push", "origin", "HEAD:refs/heads/feat/tasks"]);
    edit_pr(&dir, |pr| pr["headRefOid"] = base.clone().into());
    std::fs::write(
        dir.join("publication.json"),
        serde_json::to_vec(&Publication {
            comment_url: Some("https://github.com/o/r/pull/12#issuecomment-1".into()),
            label: Some("removed".into()),
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    (runs, dir, base)
}

#[test]
fn effective_push_urls_must_all_be_the_pr_repository() {
    for urls in [
        vec!["git@github.com:o/r.git", "https://github.com/O/r.git"],
        vec!["git@github.com:o/r.git", "git@github.com:other/repo.git"],
        vec!["git@github.com:o/r.git", "unproved-local-path"],
        vec!["git@github.com:other/repo.git", "git@github.com:o/r.git"],
    ] {
        let (runs, dir, base) = local_publication_fixture();
        let repo = runs.parent().unwrap();
        for url in &urls {
            local_git(repo, &["config", "--add", "remote.origin.pushurl", url]);
        }
        let mut runner = LocalPublication {
            calls: Vec::new(),
            reject_push: true,
            reject_comment: false,
            real_urls: true,
        };
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{:?}",
            receipt.failure
        );
        let pushes = runner
            .calls
            .iter()
            .filter(|c| c.label == "git-push-blocks")
            .count();
        assert_eq!(pushes, usize::from(urls[1] == "https://github.com/O/r.git"));
        assert!(publication(&dir).writeback.unwrap().starts_with("attached"));
        assert_eq!(
            local_git(
                &repo.join("remote.git"),
                &["rev-parse", "refs/heads/feat/tasks"]
            )
            .trim(),
            base
        );
        std::fs::remove_dir_all(repo).unwrap();
    }
}

#[test]
fn new_and_replacement_commits_with_converted_bytes_fall_back_without_pushing() {
    for replacement in [false, true] {
        let (runs, dir, _) = local_publication_fixture();
        let repo = runs.parent().unwrap();
        std::fs::rename(dir.join("blocks/tasks.yaml"), dir.join("blocks/tasks.yml")).unwrap();
        std::fs::write(dir.join("blocks/tasks.yml"), "steps: []\n").unwrap();
        let mut runner = LocalPublication {
            calls: Vec::new(),
            reject_push: true,
            reject_comment: true,
            real_urls: false,
        };
        if replacement {
            assert_eq!(
                publish(&mut runner, &runs, RUN, &machine()).result,
                ReceiptResult::Failed
            );
            assert!(publication(&dir).writeback_commit.is_some());
        }
        std::fs::write(repo.join(".gitattributes"), "*.yml text eol=lf\n").unwrap();
        local_git(repo, &["add", ".gitattributes"]);
        local_git(repo, &["commit", "-m", "declare block EOL"]);
        let base = local_git(repo, &["rev-parse", "HEAD"]).trim().to_string();
        edit_pr(&dir, |pr| pr["headRefOid"] = base.clone().into());
        local_git(repo, &["push", "origin", "HEAD:refs/heads/feat/tasks"]);
        let bytes = "# block\r\nsteps: []\r\n";
        std::fs::write(dir.join("blocks/tasks.yml"), bytes).unwrap();
        runner.calls.clear();
        runner.reject_push = false;
        runner.reject_comment = false;
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{:?}",
            receipt.failure
        );
        assert!(!runner.calls.iter().any(|c| c.label == "git-push-blocks"));
        let commit = runner
            .calls
            .iter()
            .find(|c| c.label == "git-blocks-content")
            .unwrap()
            .args[1]
            .split(':')
            .next()
            .unwrap();
        assert_eq!(
            local_git(
                repo,
                &[
                    "show",
                    &format!("{commit}:test-app/.qaren/actions/tasks.yml")
                ]
            ),
            "# block\nsteps: []\n"
        );
        assert!(std::fs::read_to_string(dir.join("blocks-comment.md"))
            .unwrap()
            .contains(bytes));
        assert_eq!(
            local_git(
                &repo.join("remote.git"),
                &["rev-parse", "refs/heads/feat/tasks"]
            )
            .trim(),
            base
        );
        assert!(!dir.join("writeback-wt").exists());
        std::fs::remove_dir_all(repo).unwrap();
    }
}

struct LocalFetchForge {
    git: LocalPublication,
    ssh: PathBuf,
    fetch_failure: bool,
    read_failure: bool,
}

impl Runner for LocalFetchForge {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if (self.fetch_failure && spec.label == "git-fetch-url")
            || (self.read_failure && spec.label == "git-ls-remote")
        {
            self.git.calls.push(spec.clone());
            return CmdOutput::failed(1, "fixture lookup unavailable");
        }
        self.git.execute(
            &spec
                .clone()
                .env(
                    "GIT_SSH_COMMAND",
                    &format!("/bin/sh {}", self.ssh.display()),
                )
                .env("GIT_SSH_VARIANT", "ssh"),
            interruptible,
        )
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        unreachable!()
    }
    fn spawn_piped_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<PipedChild> {
        unreachable!()
    }
    fn sleep(&mut self, _: std::time::Duration) {}
    fn now_epoch_ms(&self) -> u64 {
        0
    }
    fn commands_executed(&self) -> u64 {
        self.git.commands_executed()
    }
}

#[test]
fn real_git_readback_requires_the_pr_fetch_destination_with_a_fake_forge() {
    for mode in [
        "mirror",
        "landed",
        "unknown",
        "lookup-failure",
        "read-failure",
        "fallback",
        "rewrite",
    ] {
        let (runs, dir, base) = local_publication_fixture();
        let repo = runs.parent().unwrap();
        let mut old_runner = LocalPublication {
            calls: Vec::new(),
            reject_push: true,
            reject_comment: true,
            real_urls: false,
        };
        assert_eq!(
            publish(&mut old_runner, &runs, RUN, &machine()).result,
            ReceiptResult::Failed
        );
        let cached = publication(&dir).writeback_commit.unwrap();
        let mirror = repo.join("mirror.git");
        std::fs::create_dir(&mirror).unwrap();
        local_git(&mirror, &["init", "--bare"]);
        local_git(
            repo,
            &[
                "push",
                mirror.to_str().unwrap(),
                &format!("{cached}:refs/heads/feat/tasks"),
            ],
        );
        if mode == "landed" {
            local_git(
                repo,
                &["push", "origin", &format!("{cached}:refs/heads/feat/tasks")],
            );
        }
        edit_pr(&dir, |pr| pr["url"] = "https://fixture/o/r/pull/12".into());
        let fetch = match mode {
            "mirror" | "fallback" => "git@fixture:mirror/r.git",
            "unknown" => mirror.to_str().unwrap(),
            _ => "git@fixture:o/r.git",
        };
        local_git(repo, &["remote", "set-url", "origin", fetch]);
        local_git(
            repo,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "ssh://git@fixture/o/r.git",
            ],
        );
        if mode == "rewrite" {
            local_git(
                repo,
                &[
                    "config",
                    "url.git@fixture:mirror/.insteadOf",
                    "git@fixture:o/",
                ],
            );
        }
        let ssh = repo.join("local-ssh.sh");
        std::fs::write(&ssh, format!(
            "for arg do request=$arg; done\ncase \"$request\" in\n  *mirror/r.git*) destination='{}';;\n  *o/r.git*) destination='{}';;\n  *) exit 1;;\nesac\ncase \"$request\" in\n  git-upload-pack*) exec git-upload-pack \"$destination\";;\n  git-receive-pack*) exec git-receive-pack \"$destination\";;\n  *) exit 1;;\nesac\n",
            mirror.display(), repo.join("remote.git").display(),
        )).unwrap();
        let mut runner = LocalFetchForge {
            git: LocalPublication {
                calls: Vec::new(),
                reject_push: mode == "fallback",
                reject_comment: false,
                real_urls: true,
            },
            ssh,
            fetch_failure: mode == "lookup-failure",
            read_failure: mode == "read-failure",
        };
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{mode}: {:?}",
            receipt.failure
        );
        let pushes: Vec<_> = runner
            .git
            .calls
            .iter()
            .filter(|call| call.label == "git-push-blocks")
            .collect();
        assert_eq!(pushes.len(), usize::from(mode != "landed"), "{mode}");
        if matches!(
            mode,
            "mirror" | "unknown" | "lookup-failure" | "fallback" | "rewrite"
        ) {
            assert!(
                !runner
                    .git
                    .calls
                    .iter()
                    .any(|call| call.label == "git-ls-remote"),
                "{mode}"
            );
        }
        let remote = local_git(
            &repo.join("remote.git"),
            &["rev-parse", "refs/heads/feat/tasks"],
        );
        assert_eq!(
            remote.trim(),
            if mode == "fallback" { &base } else { &cached },
            "{mode}"
        );
        assert_eq!(
            local_git(&mirror, &["rev-parse", "refs/heads/feat/tasks"]).trim(),
            cached
        );
        if mode == "fallback" {
            assert!(receipt.outcomes["writeback"].starts_with("attached "));
            assert!(std::fs::read_to_string(dir.join("blocks-comment.md"))
                .unwrap()
                .contains("steps: []\n"));
        } else {
            assert_eq!(receipt.outcomes["writeback"], format!("committed {cached}"));
            assert!(!runner
                .git
                .calls
                .iter()
                .any(|call| call.label == "gh-pr-comment"));
        }
        assert_eq!(
            publication(&dir).writeback_commit.as_deref(),
            Some(cached.as_str())
        );
        assert_eq!(local_git(repo, &["rev-parse", "HEAD"]).trim(), base);
        std::fs::remove_dir_all(repo).unwrap();
    }
}

#[test]
fn only_the_admission_trimmed_copy_is_ever_uploaded() {
    let (runs, dir) = run_dir(false);
    std::fs::remove_file(dir.join("media/video-published.mp4")).unwrap();
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let comment = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "gh-pr-comment")
        .unwrap();
    assert!(!comment.args.iter().any(|arg| arg.contains("video")));
    assert!(dir.join("media/video.mp4").is_file());
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(!body.contains("Video of the walk is attached below"));
}

#[test]
fn a_missing_failing_screenshot_is_not_claimed_or_uploaded() {
    let (runs, dir) = run_dir(false);
    std::fs::remove_file(dir.join("screenshots/01.png")).unwrap();
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let comment = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "gh-pr-comment")
        .unwrap();
    assert!(!comment.args.iter().any(|arg| arg.contains("screenshots")));
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(body.contains("**Failing step**"));
    assert!(!body.contains("![Failing step]"));
    assert!(body.contains("Video of the walk is attached below"));
}

#[test]
fn a_post_admission_interruption_withholds_the_copy_and_upload() {
    let (runs, dir) = run_dir(false);
    let mut ledger: qaren::core::Ledger =
        serde_json::from_slice(&std::fs::read(dir.join("ledger.json")).unwrap()).unwrap();
    ledger.publication_interrupted = true;
    let mut encoder = MockRunner::new();
    let status = qaren::record::publication_copy(
        &mut encoder,
        &dir,
        Some(12_345),
        None,
        ledger.publication_interrupted,
    );
    assert_eq!(
        status,
        VideoStatus::Unavailable("app continuity was interrupted after admission".into())
    );
    assert!(!qaren::record::published_video_path(&dir).exists());
    assert!(encoder.calls.is_empty());
    edit_pr(&dir, |pr| {
        pr["video"] = serde_json::to_value(&status).unwrap()
    });
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let comment = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "gh-pr-comment")
        .unwrap();
    assert!(!comment
        .args
        .iter()
        .any(|arg| arg.contains("video-published")));
    assert!(dir.join("media/video.mp4").is_file());
}

#[test]
fn only_a_final_uncancelled_verified_owned_terminal_result_admits_publication() {
    use qaren::failure::FailureCode;
    let unverified = TerminalResult {
        final_verification: FinalVerification {
            matched: false,
            detail: Some("checkout HEAD moved".into()),
            ..final_terminal().final_verification
        },
        ..final_terminal()
    };
    let unowned = TerminalResult {
        ownership_proven: false,
        ..final_terminal()
    };
    let cancelled_and_changed = TerminalResult {
        cancelled: true,
        ..unverified.clone()
    };
    for (terminal, code) in [
        (None, FailureCode::RunRecordInvalid),
        (Some(cancelled_and_changed), FailureCode::RunCancelled),
        (Some(unverified), FailureCode::CandidateDrifted),
        (Some(unowned), FailureCode::OwnershipUnproven),
    ] {
        let (runs, dir) = run_dir(false);
        let mut record = qaren::runrecord::RunRecord::load(&runs, RUN).unwrap();
        record.terminal = terminal;
        record.save(&runs).unwrap();
        let mut runner = Git(MockRunner::new());
        let receipt = publish(&mut runner, &runs, RUN, &machine());
        assert_eq!(receipt.failure.as_ref().map(|f| f.code), Some(code));
        assert!(runner.0.calls.is_empty(), "no forge or git effect may run");
        assert!(!dir.join("publication.json").exists());
    }
}

#[test]
fn publication_uses_only_the_projected_ledger_and_structured_verdict() {
    let (runs, dir) = run_dir(false);
    edit_pr(&dir, |pr| pr["blocks"] = serde_json::json!([]));
    let output = std::process::Command::new("node")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../qaren-core"))
        .args(["--input-type=module", "--eval", r#"
import assert from 'node:assert/strict';
import { parsePlan } from './dist/qa/plan.js';
import { runPlan } from './dist/qa/walker.js';
import { join } from './dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './test/unit/qa/judgment-fixtures.ts';
const values = ['CanaryAlpha77', '1234567890', ' Café ', 'pw', '47'];
const plan = values.map((value, i) => `${i + 1}. Type "${value}" into "field${i}"`).join('\n')
  + '\n✓ "Readable ready"\n✓ "Missing banner"';
const blocks = parsePlan(plan).blocks;
assert.ok(blocks);
const actions = [];
let filled = false;
const observe = () => screen([
  element('@ready', 'Readable ready', { kind: 'text' }),
  ...values.map((value, i) => element(`@input${i}`, `Field ${i}`, {
    kind: 'input', testID: `field${i}`, value: i === 3 ? 'pw' : i === 4 ? '47' : '', secure: i === 3,
  })),
  element('@prefilled', 'Account', { kind: 'input', value: '654321' }),
  ...(filled ? [
    element('@echo', 'CanaryAlpha77', { kind: 'text' }),
    element('@digits', '1234 5678 90', { kind: 'text', testID: 'account-1234-5678-90' }),
    element('@normalized', 'Café', { kind: 'text' }),
    ...['4815', '1122'].flatMap((code, row) => join([...code].flatMap((label, i) => [
      { ref: `@group${row}${i}`, type: 'Group' },
      { ref: `@box${row}${i}`, type: 'StaticText', label,
        rect: { x: i * 48, y: 100 + row * 60, width: 32, height: 40 } },
    ]), []).elements),
  ] : []),
]);
const f = walker([], scriptedJudge(() => assert.fail('literal plan must not ask a model')));
f.deps.captureScreen = async () => observe();
f.deps.fill = async (ref, value) => {
  actions.push(value);
  filled = true;
  return { ok: true, proven: true };
};
f.deps.screenshot = async () => assert.fail('private screenshots must be withheld');
const ledger = await runPlan(blocks, f.deps);
assert.deepEqual(actions, values);
assert.equal(ledger.verdict, 'FAIL');
assert.equal(ledger.steps.filter(row => row.outcome === 'pass').length, 6);
assert.ok(ledger.failure.seen.endsWith('[screen text withheld: a secure field is on screen]'));
assert.equal(observe().elements.filter(e => e.kind === 'text' && e.label?.length === 1).length, 8);
process.stdout.write(JSON.stringify(ledger));
"#])
        .output()
        .expect("node on PATH is required to execute core privacy projection");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ledger: qaren::core::Ledger = serde_json::from_slice(&output.stdout).unwrap();
    std::fs::write(dir.join("ledger.json"), &output.stdout).unwrap();
    qaren::report::write(
        &dir,
        &qaren::report::ReportInput {
            run_id: RUN,
            platform: "ios",
            app_id: "com.rndevagent.testapp",
            device: "qaren-check",
            ledger: &ledger,
        },
    )
    .unwrap();

    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    std::fs::write(
        dir.join("receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(report_content(&body, "").starts_with("FAIL"));
    assert!(body.contains("Readable ready"), "{body}");
    assert!(body.contains("•••"), "{body}");
    let report = std::fs::read_to_string(dir.join("report.md")).unwrap();
    assert!(report.contains("Readable ready"), "{report}");
    assert!(report.contains("Missing banner"), "{report}");
    let saved_receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(saved_receipt["run_id"], RUN);
    fn scan(dir: &Path, repo: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path, repo);
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            let text = text.replace(repo.to_str().unwrap(), "[fixture-root]");
            let text = if path.file_name().is_some_and(|name| name == "comment.md") {
                report_content(&text, "")
            } else {
                &text
            };
            for value in [
                "CanaryAlpha77",
                "1234567890",
                "1234 5678 90",
                "Café",
                "Café",
                "654321",
                "4815",
                "1122",
                "4 | 8 | 1 | 5",
                "1 | 1 | 2 | 2",
                "account-1234-5678-90",
                "pw",
                "47",
            ] {
                assert!(!text.contains(value), "{} contains {value}", path.display());
            }
        }
    }
    scan(&dir, runs.parent().unwrap());
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn both_comment_paths_reconcile_only_the_authenticated_authors_report_fingerprint() {
    for variant in [
        "other-author",
        "other-fingerprint",
        "other-run",
        "missing-author",
        "matching",
    ] {
        let (runs, dir) = run_dir(true);
        let mut first = Git(MockRunner::new());
        script_comment_and_label(&mut first.0);
        first
            .0
            .expect_run("gh pr comment", CmdOutput::failed(1, "offline"));
        assert_eq!(
            publish(&mut first, &runs, RUN, &machine()).result,
            ReceiptResult::Failed
        );
        let bodies = ["comment.md", "blocks-comment.md"]
            .map(|file| std::fs::read_to_string(dir.join(file)).unwrap());
        let pending = Publication {
            comment_attempted: true,
            blocks_comment_attempted: true,
            ..Default::default()
        };
        std::fs::write(
            dir.join("publication.json"),
            serde_json::to_vec(&pending).unwrap(),
        )
        .unwrap();
        let mut second = Git(MockRunner::new());
        second
            .0
            .expect_run("gh api user", CmdOutput::success("publisher\n"));
        for (index, body) in bodies.iter().enumerate() {
            let candidate = serde_json::json!({
                "body": match variant {
                    "other-fingerprint" => {
                        let (marker, content) = body.split_once('\n').unwrap();
                        let (prefix, _) = marker.split_once(" report=").unwrap();
                        format!("{prefix} report={} -->\n{content}", "0".repeat(64))
                    },
                    "other-run" => body.replacen(RUN, "another-run", 1),
                    _ => format!("{}\nAttachment markup", body.lines().next().unwrap()),
                },
                "author": match variant {
                    "other-author" => serde_json::json!({"login": "someone-else"}),
                    "missing-author" => serde_json::Value::Null,
                    _ => serde_json::json!({"login": "publisher"}),
                },
                "url": format!("https://github.com/o/r/pull/12#issuecomment-adopted-{index}"),
            });
            second.0.expect_run(
                "gh pr view 12",
                CmdOutput::success(&serde_json::json!({"comments": [candidate]}).to_string()),
            );
            if variant != "matching" {
                second.0.expect_run(
                    "gh pr comment",
                    CmdOutput::success(&format!(
                        "https://github.com/o/r/pull/12#issuecomment-new-{index}"
                    )),
                );
            }
            if index == 0 {
                second
                    .0
                    .expect_run("gh pr view https://github.com/o/r/pull/12", view(""));
            }
        }
        let receipt = publish(&mut second, &runs, RUN, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{variant}: {:?}",
            receipt.failure
        );
        assert_eq!(calls_named(&second.0, "gh-user"), 1);
        assert_eq!(
            calls_named(&second.0, "gh-pr-comment"),
            if variant == "matching" { 0 } else { 2 }
        );
        let suffix = if variant == "matching" {
            "adopted"
        } else {
            "new"
        };
        assert_eq!(
            receipt.outcomes["comment"],
            format!("https://github.com/o/r/pull/12#issuecomment-{suffix}-0")
        );
        assert_eq!(
            receipt.outcomes["writeback"],
            format!("attached https://github.com/o/r/pull/12#issuecomment-{suffix}-1")
        );
        for (file, expected) in ["comment.md", "blocks-comment.md"].into_iter().zip(bodies) {
            assert_eq!(std::fs::read_to_string(dir.join(file)).unwrap(), expected);
        }
        assert_eq!(second.0.remaining(), 0);
    }
}

#[test]
fn privacy_comment_names_only_the_video_cause() {
    let (runs, dir) = run_dir(false);
    edit_pr(&dir, |pr| {
        pr["videoPublication"] = "withheld-privacy".into();
        pr["blocks"] = serde_json::json!([]);
    });
    let path = dir.join("ledger.json");
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    ledger["mediaWithheld"] = serde_json::json!({"screenshots":{"reason":"echo","source":"typed","line":867,"count":42},"video":{"reason":"generic-value","kind":"other","line":987}});
    std::fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    let receipt = publish(&mut runner, &runs, RUN, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(body.contains("Video withheld: screenshot privacy disallowed capture during the walk (generic-value)."), "{body}");
    for private in ["987", "867", "typed", "other", "echo"] {
        assert!(!body.contains(private), "{body}");
    }
}
