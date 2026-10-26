use crate::core::Ledger;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::{self, PrInfo, NEEDS_QA};
use crate::receipt::{Receipt, ReceiptResult};
use crate::record::{self, VideoPublication, VideoStatus};
use crate::redact::{redact_machine, MachineIdentity};
use crate::report::{self, PrRun, ReportInput};
use crate::runrecord::{validate_run_id, RunRecord};
use crate::timefmt;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// `<run_dir>/pr.json`: what `qaren pr` tested, for `qaren publish`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRunRecord {
    pub number: u64,
    pub url: String,
    pub head_ref_oid: String,
    pub head_ref_name: String,
    pub is_cross_repository: bool,
    pub repo_root: PathBuf,
    pub app_rel: String,
    pub platform: String,
    pub app_id: String,
    pub device: String,
    pub plan_sha256: String,
    pub video: VideoStatus,
    #[serde(default, deserialize_with = "video_publication")]
    pub video_publication: VideoPublication,
    #[serde(default, deserialize_with = "withholding_reason")]
    pub video_withholding_reason: Option<String>,
    #[serde(default)]
    pub tested_older_commit: bool,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub identity_values: Vec<String>,
}

fn video_publication<'de, D: serde::Deserializer<'de>>(d: D) -> Result<VideoPublication, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

fn withholding_reason<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

// `<run_dir>/publication.json`, rewritten atomically after every step so a rerun resumes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    #[serde(default)]
    pub rendered: bool,
    #[serde(default)]
    pub comment_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback_commit: Option<String>,
    #[serde(default)]
    pub blocks_comment_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback: Option<String>,
}

const PUBLICATION: &str = "publication.json";
const LOCK: &str = "publish.lock";
const COMMENT_BODY: &str = "comment.md";
const BLOCKS_BODY: &str = "blocks-comment.md";

fn failure(detail: impl Into<String>, next: impl Into<String>) -> Failure {
    Failure::new("publish", FailureCode::PublishFailed, detail, next)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Failure> {
    let bytes = std::fs::read(path).map_err(|e| {
        failure(
            format!("cannot read {}: {e}", path.display()),
            "publish a run that `qaren pr` completed",
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        failure(
            format!("{} is unreadable: {e}", path.display()),
            "publish a run that `qaren pr` completed",
        )
    })
}

fn save(run_dir: &Path, publication: &Publication) -> Result<(), Failure> {
    let path = run_dir.join(PUBLICATION);
    let tmp = run_dir.join(format!("{PUBLICATION}.tmp"));
    let bytes = serde_json::to_vec_pretty(publication).unwrap_or_default();
    std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            failure(
                format!("cannot persist {}: {e}", path.display()),
                "fix the run directory permissions, then re-run qaren publish",
            )
        })
}

fn pr_info(pr: &PrRunRecord) -> PrInfo {
    PrInfo {
        number: pr.number,
        url: pr.url.clone(),
        head_ref_oid: pr.head_ref_oid.clone(),
        head_ref_name: pr.head_ref_name.clone(),
        is_cross_repository: pr.is_cross_repository,
        labels: Vec::new(),
    }
}

fn find_own_comment(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    marker: &str,
    actor: &str,
    cwd: &Path,
) -> Result<Option<String>, Failure> {
    #[derive(Deserialize)]
    struct Author {
        login: String,
    }
    #[derive(Deserialize)]
    struct Comment {
        body: String,
        url: String,
        author: Option<Author>,
    }
    #[derive(Deserialize)]
    struct Comments {
        comments: Vec<Comment>,
    }
    let repo = pr.repo().ok_or_else(|| {
        failure(
            format!("unexpected PR URL {}", pr.url),
            "re-run qaren pr for this pull request",
        )
    })?;
    let output = runner.run(
        &CmdSpec::new(
            "gh-pr-comments",
            "gh",
            &[
                "pr",
                "view",
                &pr.number.to_string(),
                "-R",
                &repo,
                "--json",
                "comments",
            ],
            60,
        )
        .cwd(cwd),
    );
    if !output.ok() {
        return Err(failure(
            format!(
                "could not list comments to confirm an earlier post: {}",
                output.summary()
            ),
            "re-run qaren publish once gh can read the pull request",
        ));
    }
    let comments: Comments = serde_json::from_str(output.stdout.trim()).map_err(|e| {
        failure(
            format!("unreadable comment list: {e}"),
            "re-run qaren publish",
        )
    })?;
    Ok(comments
        .comments
        .into_iter()
        .find(|c| {
            c.body.lines().next() == Some(marker)
                && c.author.as_ref().is_some_and(|a| a.login == actor)
        })
        .map(|c| c.url))
}

fn authenticated_login(runner: &mut dyn Runner, cwd: &Path) -> Result<String, Failure> {
    let output =
        runner.run(&CmdSpec::new("gh-user", "gh", &["api", "user", "--jq", ".login"], 60).cwd(cwd));
    if !output.ok() || output.stdout.trim().is_empty() {
        return Err(failure(
            "could not identify the authenticated publishing user",
            "check gh authentication, then re-run qaren publish",
        ));
    }
    Ok(output.stdout.trim().to_string())
}

#[allow(clippy::too_many_arguments)]
fn post_once(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    run_dir: &Path,
    body_file: &str,
    attachments: &[(PathBuf, Option<String>)],
    attempted: bool,
    actor: &mut Option<String>,
    render_body: &mut dyn FnMut() -> Result<String, Failure>,
    mark_attempted: &mut dyn FnMut() -> Result<(), Failure>,
) -> Result<String, Failure> {
    let rendered = render_body()?;
    let (marker, content) = rendered
        .split_once('\n')
        .ok_or_else(|| failure("report has no marker line", "re-run qaren publish"))?;
    let prefix = marker
        .strip_suffix(" -->")
        .ok_or_else(|| failure("report has an invalid marker", "re-run qaren publish"))?;
    let marker = format!(
        "{prefix} report={} -->",
        crate::candidate::sha256_hex(content.as_bytes())
    );
    let body = format!("{marker}\n{content}");
    if attempted {
        if actor.is_none() {
            *actor = Some(authenticated_login(runner, run_dir)?);
        }
        if let Some(url) =
            find_own_comment(runner, pr, &marker, actor.as_deref().unwrap(), run_dir)?
        {
            return Ok(url);
        }
    }
    std::fs::write(run_dir.join(body_file), body).map_err(|e| {
        failure(
            format!("cannot write {body_file}: {e}"),
            "fix the run directory permissions, then re-run",
        )
    })?;
    mark_attempted()?;
    github::comment_create(runner, pr, Path::new(body_file), attachments, run_dir)
}

use crate::worktree::git;

type Blocks = Vec<(String, String)>;
type Withheld = Vec<(String, &'static str)>;

// Blocks leave the machine verbatim, and only when the walk itself was eligible for publication and
// the machine redaction would not change them; anything else stays in the run directory, never rewritten.
fn saved_blocks(
    run_dir: &Path,
    pr: &PrRunRecord,
    machine: &MachineIdentity,
) -> Result<(Blocks, Withheld), Failure> {
    let mut published = Vec::new();
    let mut withheld = Vec::new();
    for slug in &pr.blocks {
        let path = worktree::safe_slug(slug)
            .then(|| {
                crate::actions::action_path(&run_dir.join("blocks"), slug)
                    .ok()
                    .flatten()
            })
            .flatten();
        let Some(path) = path else {
            return Err(failure(
                format!("the saved block {slug} is missing or ambiguous in the run directory"),
                "re-run qaren pr to save the blocks again",
            ));
        };
        let real = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file());
        let Some(yaml) = real.then(|| std::fs::read_to_string(&path).ok()).flatten() else {
            return Err(failure(
                format!("the saved block {slug} is missing or unreadable in the run directory"),
                "re-run qaren pr to save the blocks again",
            ));
        };
        if pr.video_publication != VideoPublication::Eligible {
            withheld.push((slug.clone(), "the walk was not eligible for publication"));
        } else if redact_machine(&yaml, machine) != yaml {
            withheld.push((
                slug.clone(),
                "the block carries a secret or machine identity",
            ));
        } else {
            published.push((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                yaml,
            ));
        }
    }
    Ok((published, withheld))
}

// `[HOST/]OWNER/REPO` a remote URL points at, for https, ssh and scp-style forms.
fn remote_repo(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("ssh://"))
        .map(|r| r.split_once('@').map_or(r, |(_, host)| host).to_string())
        .or_else(|| {
            let (_, scp) = url.split_once('@')?;
            Some(scp.replacen(':', "/", 1))
        })?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() == 3).then(|| parts.join("/").to_ascii_lowercase())
}

// The lease authenticates the ref value only; the destination must also be the PR's repository.
fn origin_is_pr_repo(runner: &mut dyn Runner, pr: &PrRunRecord) -> bool {
    let output = git(
        runner,
        "git-push-url",
        &pr.repo_root,
        &["remote", "get-url", "--push", "--all", "origin"],
        20,
    );
    let expected = pr_info(pr).repo().map(|r| r.to_ascii_lowercase());
    output.ok()
        && expected.is_some()
        && !output.stdout.trim().is_empty()
        && output
            .stdout
            .lines()
            .all(|url| remote_repo(url.trim()) == expected)
}

// Every existing component must be a real directory; missing ones are created. A PR controls this tree.
fn real_dir_under(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut at = root.to_path_buf();
    for part in rel.components() {
        let std::path::Component::Normal(name) = part else {
            return Err(format!("{} is not a plain relative path", rel.display()));
        };
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => return Err(format!("{} is not a real directory", at.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&at).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(at)
}

fn fence(content: &str, min: usize) -> String {
    let longest = content.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(min.max(longest + 1))
}

fn action_rel(app_rel: &str, filename: &str) -> String {
    let rel = format!(".qaren/actions/{filename}");
    if app_rel == "." {
        rel
    } else {
        format!("{app_rel}/{rel}")
    }
}

// Commits the blocks on the tested commit in a short-lived worktree; returns the commit sha.
fn commit_blocks(
    runner: &mut dyn Runner,
    run_id: &str,
    run_dir: &Path,
    pr: &PrRunRecord,
    blocks: &[(String, String)],
) -> Result<String, String> {
    let repo = &pr.repo_root;
    // The tested commit may be gone from the object store after a force-push; fetch it by id.
    git(
        runner,
        "git-fetch-tested",
        repo,
        &["fetch", "origin", &pr.head_ref_oid],
        300,
    );
    let tmp = run_dir.join("writeback-wt");
    if std::fs::symlink_metadata(&tmp).is_ok() {
        let outcome = worktree::remove(runner, repo, &tmp);
        if !outcome.clean() {
            return Err(format!(
                "an earlier writeback worktree is still present: {}",
                outcome.render()
            ));
        }
    }
    let added = git(
        runner,
        "git-worktree-add",
        repo,
        &[
            "worktree",
            "add",
            "--detach",
            &tmp.to_string_lossy(),
            &pr.head_ref_oid,
        ],
        120,
    );
    let result = (|| {
        if !added.ok() {
            return Err(format!("git worktree add failed: {}", added.summary()));
        }
        let mut paths = Vec::new();
        for (filename, yaml) in blocks {
            let rel = action_rel(&pr.app_rel, filename);
            let dir = real_dir_under(&tmp, Path::new(&rel).parent().unwrap_or(Path::new("")))?;
            let slug = Path::new(filename).file_stem().unwrap().to_string_lossy();
            if let Some(existing) = crate::actions::action_path(&dir, &slug)? {
                if existing.file_name() != Some(std::ffi::OsStr::new(filename)) {
                    return Err(format!("{rel} would create an ambiguous action"));
                }
            }
            let dest = dir.join(filename);
            if std::fs::symlink_metadata(&dest).is_ok_and(|m| !m.file_type().is_file()) {
                return Err(format!("{rel} exists and is not a regular file"));
            }
            std::fs::write(&dest, yaml).map_err(|e| e.to_string())?;
            paths.push(rel);
        }
        let slugs: Vec<_> = blocks
            .iter()
            .map(|(filename, _)| Path::new(filename).file_stem().unwrap().to_string_lossy())
            .collect();
        let mut add_args = vec!["add", "-f", "--"];
        add_args.extend(paths.iter().map(String::as_str));
        let added = git(runner, "git-add-blocks", &tmp, &add_args, 60);
        if !added.ok() {
            return Err(format!("git add failed: {}", added.summary()));
        }
        let subject = format!("qaren: save block {}", slugs.join(", "));
        let trailer = format!("Qaren-Run: {run_id}");
        let committed = git(
            runner,
            "git-commit-blocks",
            &tmp,
            &["commit", "-m", &subject, "-m", &trailer],
            60,
        );
        if !committed.ok() {
            return Err(format!("git commit failed: {}", committed.summary()));
        }
        let head = git(runner, "git-head", &tmp, &["rev-parse", "HEAD"], 20);
        if !head.ok() {
            return Err(format!("git rev-parse failed: {}", head.summary()));
        }
        let commit = head.stdout.trim().to_string();
        if !cached_blocks_match(runner, pr, &commit, blocks) {
            return Err("the writeback commit does not preserve the admitted blocks".into());
        }
        Ok(commit)
    })();
    let removed = worktree::remove(runner, repo, &tmp);
    match (result, removed.clean()) {
        (Ok(commit), true) => Ok(commit),
        (Ok(_), false) => Err(format!(
            "the writeback worktree was not removed: {}",
            removed.render()
        )),
        (Err(e), _) => Err(e),
    }
}

fn cached_blocks_match(
    runner: &mut dyn Runner,
    pr: &PrRunRecord,
    commit: &str,
    blocks: &[(String, String)],
) -> bool {
    let parents = git(
        runner,
        "git-blocks-parents",
        &pr.repo_root,
        &["rev-list", "--parents", "-n", "1", commit],
        20,
    );
    if !parents.ok()
        || parents.stdout.split_whitespace().collect::<Vec<_>>() != [commit, &pr.head_ref_oid]
    {
        return false;
    }
    let paths: Vec<_> = blocks
        .iter()
        .map(|(filename, _)| action_rel(&pr.app_rel, filename))
        .collect();
    let diff = git(
        runner,
        "git-blocks-diff",
        &pr.repo_root,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            &pr.head_ref_oid,
            commit,
            "--",
        ],
        20,
    );
    if !diff.ok()
        || diff
            .stdout
            .split_terminator('\0')
            .any(|path| !paths.iter().any(|p| p == path))
    {
        return false;
    }
    blocks.iter().zip(paths).all(|((_, yaml), path)| {
        let sibling = Path::new(&path).with_extension(if path.ends_with(".yml") {
            "yaml"
        } else {
            "yml"
        });
        let entry = git(
            runner,
            "git-blocks-entry",
            &pr.repo_root,
            &[
                "ls-tree",
                "-z",
                commit,
                "--",
                &path,
                &sibling.to_string_lossy(),
            ],
            20,
        );
        if !entry.ok()
            || !entry
                .stdout
                .strip_suffix(&format!("\t{path}\0"))
                .is_some_and(|meta| {
                    let fields: Vec<_> = meta.split_whitespace().collect();
                    fields.len() == 3
                        && matches!(fields[0], "100644" | "100755")
                        && fields[1] == "blob"
                })
        {
            return false;
        }
        let content = git(
            runner,
            "git-blocks-content",
            &pr.repo_root,
            &["show", &format!("{commit}:{path}")],
            20,
        );
        content.ok() && content.stdout == *yaml
    })
}

fn push_with_lease(runner: &mut dyn Runner, pr: &PrRunRecord, commit: &str) -> bool {
    let refspec = format!("{commit}:refs/heads/{}", pr.head_ref_name);
    let lease = format!(
        "--force-with-lease={}:{}",
        pr.head_ref_name, pr.head_ref_oid
    );
    git(
        runner,
        "git-push-blocks",
        &pr.repo_root,
        &["push", "origin", &refspec, &lease],
        300,
    )
    .ok()
}

fn remote_head(runner: &mut dyn Runner, pr: &PrRunRecord) -> Option<String> {
    let destination = git(
        runner,
        "git-fetch-url",
        &pr.repo_root,
        &["remote", "get-url", "origin"],
        20,
    );
    let expected = pr_info(pr).repo().map(|repo| repo.to_ascii_lowercase());
    if !destination.ok() || expected.is_none() || remote_repo(destination.stdout.trim()) != expected
    {
        return None;
    }
    let output = git(
        runner,
        "git-ls-remote",
        &pr.repo_root,
        &[
            "ls-remote",
            "origin",
            &format!("refs/heads/{}", pr.head_ref_name),
        ],
        60,
    );
    output
        .ok()
        .then(|| output.stdout.split_whitespace().next().map(str::to_string))
        .flatten()
}

fn blocks_comment(
    run_id: &str,
    pr: &PrRunRecord,
    blocks: &[(String, String)],
    machine: &MachineIdentity,
) -> String {
    let mut out = format!("<!-- qaren-run: {run_id} blocks -->\n");
    out.push_str("These blocks were saved by the QA run but could not be pushed to the branch. Commit them to replay the walk next time.\n\n");
    out.push_str("<details><summary>Saved blocks to commit</summary>\n\n");
    // YAML is committable content, so it is fenced verbatim rather than rewritten.
    for (filename, yaml) in blocks {
        let path = action_rel(&pr.app_rel, filename);
        let tick = fence(&path, 1);
        let block = fence(yaml, 3);
        out.push_str(&format!(
            "{tick} {path} {tick}\n\n{block}yaml\n{}{}{block}\n\n",
            yaml,
            if yaml.ends_with('\n') { "" } else { "\n" }
        ));
    }
    out.push_str("</details>\n");
    redact_machine(&out, machine)
}

struct PublishLock {
    file: std::fs::File,
}

impl PublishLock {
    fn acquire(run_dir: &Path) -> Result<Self, Failure> {
        use std::os::fd::AsRawFd;
        let path = run_dir.join(LOCK);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| {
                failure(
                    format!("cannot lock {}: {e}", path.display()),
                    "re-run qaren publish",
                )
            })?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(failure(
                format!(
                    "another qaren publish holds the lock or locking failed: {}",
                    std::io::Error::last_os_error()
                ),
                "wait for it to finish, then re-run qaren publish",
            ));
        }
        Ok(Self { file })
    }
}

impl Drop for PublishLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // A concurrent fork may retain this file description until exec.
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

pub fn publish(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    machine: &MachineIdentity,
) -> Receipt {
    let mut publication = Publication::default();
    let outcome = publish_inner(runner, runs_root, run_id, machine, &mut publication);
    let (result, failure) = match outcome {
        Ok(()) => (ReceiptResult::Published, None),
        Err(f) if f.code.is_refusal() => (ReceiptResult::Refused, Some(f)),
        Err(f) => (ReceiptResult::Failed, Some(f)),
    };
    let mut receipt = Receipt::new(
        "publish",
        run_id,
        result,
        "publish",
        timefmt::iso8601_utc(runner.now_epoch_ms()),
    );
    if let Some(url) = &publication.comment_url {
        receipt.outcomes.insert("comment".into(), url.clone());
    }
    if let Some(label) = &publication.label {
        receipt.outcomes.insert("label".into(), label.clone());
    }
    if let Some(writeback) = &publication.writeback {
        receipt
            .outcomes
            .insert("writeback".into(), writeback.clone());
    }
    receipt.next_action = match &failure {
        Some(f) => f.next_action.to_string(),
        None => "nothing left; the pull request has the QA comment".to_string(),
    };
    receipt.failure = failure;
    receipt.commands_executed = runner.commands_executed();
    receipt
}

fn publish_inner(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    machine: &MachineIdentity,
    publication: &mut Publication,
) -> Result<(), Failure> {
    validate_run_id(run_id)?;
    let run_dir = RunRecord::run_dir(runs_root, run_id);
    let _lock = PublishLock::acquire(&run_dir)?;
    let run = RunRecord::load(runs_root, run_id)?;
    let terminal = run.terminal.ok_or_else(|| {
        Failure::new(
            "publish",
            FailureCode::RunRecordInvalid,
            format!("run {run_id} has no final result; it did not finish"),
            "re-run qaren pr; only a finished run can be published",
        )
    })?;
    if let Some(refusal) = terminal.publication_refusal() {
        return Err(refusal);
    }
    let pr: PrRunRecord = read_json(&run_dir.join("pr.json"))?;
    let machine = &machine.with_values(&pr.identity_values);
    let info = pr_info(&pr);
    let state = run_dir.join(PUBLICATION);
    if std::fs::symlink_metadata(&state).is_ok() {
        *publication = read_json(&state)?;
    }

    let mut publishing_actor = None;
    if publication.comment_url.is_none() {
        let mut attachments = Vec::new();
        let mut video = pr.video.clone();
        if pr.video_publication == VideoPublication::Eligible
            && pr.video == VideoStatus::Available
            && record::published_video_path(&run_dir).is_file()
        {
            attachments.push((PathBuf::from("./media/video-published.mp4"), None));
        }
        if pr.video == VideoStatus::Available && attachments.is_empty() {
            video = VideoStatus::Unavailable("published recording is unavailable".into());
        }
        let ledger: Option<Ledger> = read_json(&run_dir.join("ledger.json")).ok();
        let mut screenshot = None;
        if let Some(shot) = ledger.as_ref().and_then(report::failing_screenshot) {
            if run_dir.join(&shot).is_file() {
                attachments.push((
                    PathBuf::from(format!("./{shot}")),
                    Some("Failing step".to_string()),
                ));
                screenshot = Some(shot);
            }
        }
        // ponytail: a publisher killed mid-upload can leave gh running; a rerun inside that window may repost.
        let attempted = publication.comment_attempted;
        let url = post_once(
            runner,
            &info,
            &run_dir,
            COMMENT_BODY,
            &attachments,
            attempted,
            &mut publishing_actor,
            &mut || {
                let ledger: Ledger = read_json(&run_dir.join("ledger.json"))?;
                Ok(report::render_pr_comment(
                    &ReportInput {
                        run_id,
                        platform: &pr.platform,
                        app_id: &pr.app_id,
                        device: &pr.device,
                        ledger: &ledger,
                    },
                    run.failure.as_ref(),
                    &PrRun {
                        tested_sha: &pr.head_ref_oid,
                        tested_older_commit: pr.tested_older_commit,
                        video: &video,
                        screenshot: screenshot.as_deref(),
                        plan_sha256: &pr.plan_sha256,
                        video_publication: &pr.video_publication,
                    },
                    machine,
                ))
            },
            &mut || {
                publication.rendered = true;
                publication.comment_attempted = true;
                save(&run_dir, publication)
            },
        )?;
        publication.comment_url = Some(url);
        save(&run_dir, publication)?;
    }

    if publication.label.is_none() {
        let current = github::pr_view(runner, &pr.url, &pr.repo_root)?;
        publication.label = Some(if current.head_ref_oid != pr.head_ref_oid {
            "retained-head-changed".to_string()
        } else {
            let removed = github::remove_label(runner, &current, NEEDS_QA, &pr.repo_root)?;
            if removed { "removed" } else { "absent" }.to_string()
        });
        save(&run_dir, publication)?;
    }

    if publication.writeback.is_none() {
        let (blocks, withheld) = saved_blocks(&run_dir, &pr, machine)?;
        let withheld_note = withheld
            .iter()
            .map(|(slug, reason)| format!("withheld {slug}: {reason}"))
            .collect::<Vec<_>>()
            .join("; ");
        let mut needs_comment = false;
        if blocks.is_empty() {
            publication.writeback = Some(if withheld_note.is_empty() {
                "none".to_string()
            } else {
                withheld_note.clone()
            });
        } else if pr.is_cross_repository || !origin_is_pr_repo(runner, &pr) {
            needs_comment = true;
        } else {
            let commit = match &publication.writeback_commit {
                Some(commit) if remote_head(runner, &pr).as_deref() == Some(commit.as_str()) => {
                    publication.writeback = Some(format!("committed {commit}"));
                    Ok(commit.clone())
                }
                Some(commit) if cached_blocks_match(runner, &pr, commit, &blocks) => {
                    Ok(commit.clone())
                }
                Some(_) => commit_blocks(runner, run_id, &run_dir, &pr, &blocks),
                None => commit_blocks(runner, run_id, &run_dir, &pr, &blocks),
            };
            match commit {
                Ok(commit) => {
                    publication.writeback_commit = Some(commit.clone());
                    save(&run_dir, publication)?;
                    let landed = publication.writeback.is_some()
                        || remote_head(runner, &pr).as_deref() == Some(commit.as_str())
                        || push_with_lease(runner, &pr, &commit);
                    if landed {
                        publication.writeback = Some(format!("committed {commit}"));
                    } else {
                        needs_comment = true;
                    }
                }
                Err(_) => needs_comment = true,
            }
        }
        if needs_comment {
            let attempted = publication.blocks_comment_attempted;
            let url = post_once(
                runner,
                &info,
                &run_dir,
                BLOCKS_BODY,
                &[],
                attempted,
                &mut publishing_actor,
                &mut || Ok(blocks_comment(run_id, &pr, &blocks, machine)),
                &mut || {
                    publication.blocks_comment_attempted = true;
                    save(&run_dir, publication)
                },
            )?;
            publication.writeback = Some(format!("attached {url}"));
        }
        if !blocks.is_empty() && !withheld_note.is_empty() {
            if let Some(writeback) = publication.writeback.as_mut() {
                writeback.push_str("; ");
                writeback.push_str(&withheld_note);
            }
        }
        save(&run_dir, publication)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{fence, remote_repo, PublishLock};

    #[test]
    fn descriptor_lock_excludes_contenders_and_releases_without_unlinking() {
        let dir = std::env::temp_dir().join(format!("qaren-publish-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = PublishLock::acquire(&dir).unwrap();
        assert!(PublishLock::acquire(&dir).is_err());
        assert!(dir.join("publish.lock").exists());
        drop(first);
        let second = PublishLock::acquire(&dir).unwrap();
        assert!(PublishLock::acquire(&dir).is_err());
        drop(second);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn descriptor_inherited_by_a_child_does_not_extend_publication_ownership() {
        let dir = std::env::temp_dir().join(format!(
            "qaren-publish-inherited-lock-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let first = PublishLock::acquire(&dir).unwrap();
        // dup shares the open file description, just as inheritance across fork does.
        let inherited = first.file.try_clone().unwrap();
        assert!(PublishLock::acquire(&dir).is_err());
        drop(first);
        let next = PublishLock::acquire(&dir);
        drop(inherited);
        let next = next.expect("an inherited descriptor must not retain publication ownership");
        assert!(PublishLock::acquire(&dir).is_err());
        drop(next);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_urls_resolve_to_host_owner_repo() {
        for url in [
            "git@github.com:O/r.git",
            "https://github.com/o/r.git",
            "https://user:tok@github.com/o/r",
            "ssh://git@github.com/o/r.git",
        ] {
            assert_eq!(remote_repo(url).as_deref(), Some("github.com/o/r"), "{url}");
        }
        assert_eq!(remote_repo("https://github.com/o/r/extra"), None);
        assert_eq!(remote_repo("/local/path"), None);
    }

    #[test]
    fn fences_outgrow_the_content_they_wrap() {
        assert_eq!(fence("a: 1", 3), "```");
        assert_eq!(fence("x: |\n  ````\n", 3), "`````");
        assert_eq!(fence("dir`name", 1), "``");
    }
}
